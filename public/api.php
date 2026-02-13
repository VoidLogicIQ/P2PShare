<?php

declare(strict_types=1);

const PIN_REGEX = '/^\d{6}$/';
const PEER_ID_REGEX = '/^[a-f0-9]{32}$/';
const SIGNAL_TYPES = ['offer', 'answer', 'ice-candidate'];
const STALE_PEER_SECONDS = 90;
const ROOM_IDLE_SECONDS = 900;
const MAX_QUEUE_SIZE = 400;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    respond(false, ['error' => 'Only POST is allowed.'], 405);
}

$rawBody = file_get_contents('php://input');
if ($rawBody === false || trim($rawBody) === '') {
    respond(false, ['error' => 'Missing request body.'], 400);
}

try {
    $request = json_decode($rawBody, true, 512, JSON_THROW_ON_ERROR);
} catch (JsonException $e) {
    respond(false, ['error' => 'Invalid JSON body.'], 400);
}

if (!is_array($request) || !isset($request['action']) || !is_string($request['action'])) {
    respond(false, ['error' => 'Invalid request format.'], 400);
}

$storageDir = dirname(__DIR__) . DIRECTORY_SEPARATOR . 'server' . DIRECTORY_SEPARATOR . 'storage';
$storageFile = $storageDir . DIRECTORY_SEPARATOR . 'rooms.json';

if (!is_dir($storageDir) && !mkdir($storageDir, 0775, true) && !is_dir($storageDir)) {
    respond(false, ['error' => 'Unable to initialize storage directory.'], 500);
}

$handle = fopen($storageFile, 'c+');
if ($handle === false) {
    respond(false, ['error' => 'Unable to initialize signaling storage.'], 500);
}

if (!flock($handle, LOCK_EX)) {
    fclose($handle);
    respond(false, ['error' => 'Unable to lock signaling storage.'], 500);
}

$state = readState($handle);
cleanupStaleRooms($state);

$result = null;
$statusCode = 200;

try {
    $result = handleAction($request, $state);
} catch (RuntimeException $e) {
    $result = ['ok' => false, 'error' => $e->getMessage()];
    $statusCode = 400;
}

writeState($handle, $state);
flock($handle, LOCK_UN);
fclose($handle);

if (!is_array($result) || !isset($result['ok'])) {
    respond(false, ['error' => 'Invalid API handler result.'], 500);
}

if ($result['ok'] !== true) {
    $error = isset($result['error']) && is_string($result['error']) ? $result['error'] : 'Request failed.';
    if ($statusCode === 200) {
        $statusCode = 400;
    }
    respond(false, ['error' => $error], $statusCode);
}

$payload = isset($result['data']) && is_array($result['data']) ? $result['data'] : [];
respond(true, ['data' => $payload], 200);

function handleAction(array $request, array &$state): array
{
    $action = $request['action'];
    if (!is_string($action)) {
        return ['ok' => false, 'error' => 'Invalid action.'];
    }

    switch ($action) {
        case 'create-room':
            return createRoom($state);
        case 'join-room':
            return joinRoom($state, $request);
        case 'send-signal':
            return sendSignal($state, $request);
        case 'poll':
            return pollSignals($state, $request);
        case 'leave':
            return leaveRoom($state, $request);
        default:
            return ['ok' => false, 'error' => 'Unsupported action.'];
    }
}

function createRoom(array &$state): array
{
    for ($i = 0; $i < 1000; $i++) {
        $pin = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        if (isset($state['rooms'][$pin])) {
            continue;
        }

        $peerId = generatePeerId();
        $now = time();

        $state['rooms'][$pin] = [
            'pin' => $pin,
            'created_at' => $now,
            'updated_at' => $now,
            'sender' => ['id' => $peerId, 'last_seen' => $now],
            'receiver' => null,
            'queue_sender' => [],
            'queue_receiver' => [],
        ];

        return [
            'ok' => true,
            'data' => [
                'pin' => $pin,
                'peerId' => $peerId,
            ],
        ];
    }

    return ['ok' => false, 'error' => 'Unable to create room PIN.'];
}

function joinRoom(array &$state, array $request): array
{
    $pin = requirePin($request['pin'] ?? null);

    if (!isset($state['rooms'][$pin]) || !is_array($state['rooms'][$pin])) {
        return ['ok' => false, 'error' => 'Room not found.'];
    }

    $room = &$state['rooms'][$pin];

    if (is_array($room['receiver'] ?? null)) {
        return ['ok' => false, 'error' => 'Room already has a receiver.'];
    }

    $peerId = generatePeerId();
    $now = time();
    $room['receiver'] = ['id' => $peerId, 'last_seen' => $now];
    $room['updated_at'] = $now;
    enqueueMessage($room, 'sender', ['type' => 'receiver-connected', 'payload' => null]);

    return [
        'ok' => true,
        'data' => [
            'pin' => $pin,
            'peerId' => $peerId,
        ],
    ];
}

function sendSignal(array &$state, array $request): array
{
    $pin = requirePin($request['pin'] ?? null);
    $peerId = requirePeerId($request['peerId'] ?? null);
    $type = $request['type'] ?? null;
    $payload = $request['payload'] ?? null;

    if (!is_string($type) || !in_array($type, SIGNAL_TYPES, true)) {
        return ['ok' => false, 'error' => 'Invalid signal type.'];
    }

    if (!isset($state['rooms'][$pin]) || !is_array($state['rooms'][$pin])) {
        return ['ok' => false, 'error' => 'Room not found.'];
    }

    $room = &$state['rooms'][$pin];
    [$role, $targetRole] = resolveRole($room, $peerId);
    if ($role === null || $targetRole === null) {
        return ['ok' => false, 'error' => 'Unauthorized peer.'];
    }

    if (!isPeerConnected($room, $targetRole)) {
        return ['ok' => false, 'error' => 'Peer is not connected.'];
    }

    touchPeer($room, $role);
    $room['updated_at'] = time();
    enqueueMessage($room, $targetRole, ['type' => $type, 'payload' => $payload]);

    return ['ok' => true, 'data' => []];
}

function pollSignals(array &$state, array $request): array
{
    $pin = requirePin($request['pin'] ?? null);
    $peerId = requirePeerId($request['peerId'] ?? null);

    if (!isset($state['rooms'][$pin]) || !is_array($state['rooms'][$pin])) {
        return ['ok' => false, 'error' => 'Room not found or expired.'];
    }

    $room = &$state['rooms'][$pin];
    [$role, ] = resolveRole($room, $peerId);
    if ($role === null) {
        return ['ok' => false, 'error' => 'Unauthorized peer.'];
    }

    touchPeer($room, $role);
    $room['updated_at'] = time();

    $queueKey = $role === 'sender' ? 'queue_sender' : 'queue_receiver';
    $messages = is_array($room[$queueKey] ?? null) ? $room[$queueKey] : [];
    $room[$queueKey] = [];

    return ['ok' => true, 'data' => ['messages' => $messages]];
}

function leaveRoom(array &$state, array $request): array
{
    $pin = requirePin($request['pin'] ?? null);
    $peerId = requirePeerId($request['peerId'] ?? null);

    if (!isset($state['rooms'][$pin]) || !is_array($state['rooms'][$pin])) {
        return ['ok' => true, 'data' => []];
    }

    $room = &$state['rooms'][$pin];
    [$role, ] = resolveRole($room, $peerId);
    if ($role === null) {
        return ['ok' => true, 'data' => []];
    }

    $now = time();
    if ($role === 'sender') {
        unset($state['rooms'][$pin]);
        return ['ok' => true, 'data' => []];
    }

    $room['receiver'] = null;
    $room['queue_receiver'] = [];
    $room['updated_at'] = $now;
    if (isPeerConnected($room, 'sender')) {
        enqueueMessage($room, 'sender', ['type' => 'peer-disconnected', 'payload' => null]);
    }

    return ['ok' => true, 'data' => []];
}

function cleanupStaleRooms(array &$state): void
{
    if (!isset($state['rooms']) || !is_array($state['rooms'])) {
        $state['rooms'] = [];
        return;
    }

    $now = time();
    foreach ($state['rooms'] as $pin => &$room) {
        if (!is_array($room)) {
            unset($state['rooms'][$pin]);
            continue;
        }

        $createdAt = isset($room['created_at']) ? (int) $room['created_at'] : $now;
        $updatedAt = isset($room['updated_at']) ? (int) $room['updated_at'] : $createdAt;

        if (($now - $createdAt) > ROOM_IDLE_SECONDS && !isPeerConnected($room, 'receiver')) {
            unset($state['rooms'][$pin]);
            continue;
        }

        if (isPeerConnected($room, 'sender')) {
            $senderLastSeen = (int) ($room['sender']['last_seen'] ?? 0);
            if (($now - $senderLastSeen) > STALE_PEER_SECONDS) {
                unset($state['rooms'][$pin]);
                continue;
            }
        } else {
            unset($state['rooms'][$pin]);
            continue;
        }

        if (isPeerConnected($room, 'receiver')) {
            $receiverLastSeen = (int) ($room['receiver']['last_seen'] ?? 0);
            if (($now - $receiverLastSeen) > STALE_PEER_SECONDS) {
                $room['receiver'] = null;
                $room['queue_receiver'] = [];
                $room['updated_at'] = $now;
                enqueueMessage($room, 'sender', ['type' => 'peer-disconnected', 'payload' => null]);
            }
        } elseif (($now - $updatedAt) > ROOM_IDLE_SECONDS) {
            unset($state['rooms'][$pin]);
        }
    }
    unset($room);
}

function resolveRole(array $room, string $peerId): array
{
    $senderId = is_array($room['sender'] ?? null) ? ($room['sender']['id'] ?? '') : '';
    $receiverId = is_array($room['receiver'] ?? null) ? ($room['receiver']['id'] ?? '') : '';

    if (is_string($senderId) && hash_equals($senderId, $peerId)) {
        return ['sender', 'receiver'];
    }
    if (is_string($receiverId) && hash_equals($receiverId, $peerId)) {
        return ['receiver', 'sender'];
    }
    return [null, null];
}

function isPeerConnected(array $room, string $role): bool
{
    if ($role === 'sender') {
        return is_array($room['sender'] ?? null) && is_string($room['sender']['id'] ?? null);
    }
    if ($role === 'receiver') {
        return is_array($room['receiver'] ?? null) && is_string($room['receiver']['id'] ?? null);
    }
    return false;
}

function touchPeer(array &$room, string $role): void
{
    $now = time();
    if ($role === 'sender' && is_array($room['sender'] ?? null)) {
        $room['sender']['last_seen'] = $now;
        return;
    }
    if ($role === 'receiver' && is_array($room['receiver'] ?? null)) {
        $room['receiver']['last_seen'] = $now;
    }
}

function enqueueMessage(array &$room, string $targetRole, array $message): void
{
    $queueKey = $targetRole === 'sender' ? 'queue_sender' : 'queue_receiver';
    $queue = is_array($room[$queueKey] ?? null) ? $room[$queueKey] : [];
    $queue[] = [
        'id' => bin2hex(random_bytes(8)),
        'type' => $message['type'] ?? 'unknown',
        'payload' => $message['payload'] ?? null,
        'timestamp' => time(),
    ];

    if (count($queue) > MAX_QUEUE_SIZE) {
        $queue = array_slice($queue, -MAX_QUEUE_SIZE);
    }

    $room[$queueKey] = $queue;
}

function requirePin(mixed $value): string
{
    if (!is_string($value) || preg_match(PIN_REGEX, $value) !== 1) {
        throw new RuntimeException('PIN must be a 6-digit number.');
    }
    return $value;
}

function requirePeerId(mixed $value): string
{
    if (!is_string($value) || preg_match(PEER_ID_REGEX, $value) !== 1) {
        throw new RuntimeException('Invalid peer ID.');
    }
    return $value;
}

function generatePeerId(): string
{
    return bin2hex(random_bytes(16));
}

function readState($handle): array
{
    rewind($handle);
    $raw = stream_get_contents($handle);
    if (!is_string($raw) || trim($raw) === '') {
        return ['rooms' => []];
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        return ['rooms' => []];
    }

    if (!isset($decoded['rooms']) || !is_array($decoded['rooms'])) {
        $decoded['rooms'] = [];
    }

    return $decoded;
}

function writeState($handle, array $state): void
{
    $encoded = json_encode($state, JSON_UNESCAPED_SLASHES);
    if (!is_string($encoded)) {
        throw new RuntimeException('Failed to encode signaling state.');
    }

    rewind($handle);
    ftruncate($handle, 0);
    fwrite($handle, $encoded);
    fflush($handle);
}

function respond(bool $ok, array $payload, int $statusCode): never
{
    http_response_code($statusCode);
    $response = ['ok' => $ok] + $payload;
    echo json_encode($response, JSON_UNESCAPED_SLASHES);
    exit;
}
