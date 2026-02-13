<?php

declare(strict_types=1);

use Ratchet\ConnectionInterface;
use Ratchet\Http\HttpServer;
use Ratchet\MessageComponentInterface;
use Ratchet\Server\IoServer;
use Ratchet\WebSocket\WsServer;
use React\EventLoop\Factory as LoopFactory;
use React\Socket\SocketServer;

require __DIR__ . '/vendor/autoload.php';

final class SignalingServer implements MessageComponentInterface
{
    /**
     * @var array<string, array{sender: ConnectionInterface|null, receiver: ConnectionInterface|null}>
     */
    private array $rooms = [];

    /**
     * @var array<int, array{pin: string, role: 'sender'|'receiver'}>
     */
    private array $connections = [];

    public function onOpen(ConnectionInterface $conn): void
    {
    }

    public function onMessage(ConnectionInterface $from, $msg): void
    {
        try {
            $data = json_decode((string) $msg, true, 512, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            $this->sendError($from, 'Invalid JSON payload.');
            return;
        }

        if (!is_array($data) || !isset($data['type']) || !is_string($data['type'])) {
            $this->sendError($from, 'Invalid message format.');
            return;
        }

        $type = $data['type'];

        switch ($type) {
            case 'create-room':
                $this->handleCreateRoom($from);
                return;

            case 'join-room':
                $pin = isset($data['pin']) && is_string($data['pin']) ? trim($data['pin']) : '';
                $this->handleJoinRoom($from, $pin);
                return;

            case 'offer':
            case 'answer':
            case 'ice-candidate':
                $pin = isset($data['pin']) && is_string($data['pin']) ? trim($data['pin']) : '';
                $payload = $data['payload'] ?? null;
                $this->handleRelay($from, $type, $pin, $payload);
                return;

            default:
                $this->sendError($from, 'Unsupported message type.');
                return;
        }
    }

    public function onClose(ConnectionInterface $conn): void
    {
        $this->cleanupConnection($conn);
    }

    public function onError(ConnectionInterface $conn, \Exception $e): void
    {
        $this->sendError($conn, 'Internal server error.');
        $conn->close();
        $this->cleanupConnection($conn);
    }

    private function handleCreateRoom(ConnectionInterface $conn): void
    {
        $connId = (int) $conn->resourceId;

        if (isset($this->connections[$connId])) {
            $this->sendError($conn, 'Connection is already in a room.');
            return;
        }

        $pin = $this->generateUniquePin();
        if ($pin === null) {
            $this->sendError($conn, 'Unable to generate room PIN.');
            return;
        }

        $this->rooms[$pin] = [
            'sender' => $conn,
            'receiver' => null,
        ];

        $this->connections[$connId] = [
            'pin' => $pin,
            'role' => 'sender',
        ];

        $this->send($conn, [
            'type' => 'room-created',
            'pin' => $pin,
        ]);
    }

    private function handleJoinRoom(ConnectionInterface $conn, string $pin): void
    {
        $connId = (int) $conn->resourceId;

        if (isset($this->connections[$connId])) {
            $this->sendError($conn, 'Connection is already in a room.');
            return;
        }

        if (!$this->isValidPin($pin)) {
            $this->sendError($conn, 'PIN must be a 6-digit number.');
            return;
        }

        if (!isset($this->rooms[$pin])) {
            $this->sendError($conn, 'Room not found.');
            return;
        }

        $room = &$this->rooms[$pin];
        if (!($room['sender'] instanceof ConnectionInterface)) {
            unset($this->rooms[$pin]);
            $this->sendError($conn, 'Room is no longer available.');
            return;
        }

        if ($room['receiver'] instanceof ConnectionInterface) {
            $this->sendError($conn, 'Room already has a receiver.');
            return;
        }

        $room['receiver'] = $conn;
        $this->connections[$connId] = [
            'pin' => $pin,
            'role' => 'receiver',
        ];

        $this->send($conn, [
            'type' => 'join-success',
            'pin' => $pin,
        ]);

        $this->send($room['sender'], [
            'type' => 'receiver-connected',
            'pin' => $pin,
        ]);
    }

    private function handleRelay(ConnectionInterface $from, string $type, string $pin, mixed $payload): void
    {
        $fromId = (int) $from->resourceId;

        if (!isset($this->connections[$fromId])) {
            $this->sendError($from, 'Connection is not paired.');
            return;
        }

        if (!$this->isValidPin($pin)) {
            $this->sendError($from, 'PIN must be a 6-digit number.');
            return;
        }

        $connectionMeta = $this->connections[$fromId];
        if ($connectionMeta['pin'] !== $pin) {
            $this->sendError($from, 'PIN does not match current room.');
            return;
        }

        if (!isset($this->rooms[$pin])) {
            $this->sendError($from, 'Room not found.');
            return;
        }

        $target = $this->getOppositePeer($from, $pin);
        if ($target === null) {
            $this->sendError($from, 'Peer is not connected.');
            return;
        }

        $this->send($target, [
            'type' => $type,
            'pin' => $pin,
            'payload' => $payload,
        ]);
    }

    private function cleanupConnection(ConnectionInterface $conn): void
    {
        $connId = (int) $conn->resourceId;
        if (!isset($this->connections[$connId])) {
            return;
        }

        $meta = $this->connections[$connId];
        $pin = $meta['pin'];
        $role = $meta['role'];

        unset($this->connections[$connId]);

        if (!isset($this->rooms[$pin])) {
            return;
        }

        $room = $this->rooms[$pin];
        $otherRole = $role === 'sender' ? 'receiver' : 'sender';
        $otherPeer = $room[$otherRole];

        if ($otherPeer instanceof ConnectionInterface) {
            $otherId = (int) $otherPeer->resourceId;
            unset($this->connections[$otherId]);
            $this->send($otherPeer, [
                'type' => 'peer-disconnected',
                'pin' => $pin,
            ]);
        }

        unset($this->rooms[$pin]);
    }

    private function getOppositePeer(ConnectionInterface $from, string $pin): ?ConnectionInterface
    {
        if (!isset($this->rooms[$pin])) {
            return null;
        }

        $fromId = (int) $from->resourceId;
        if (!isset($this->connections[$fromId])) {
            return null;
        }

        $role = $this->connections[$fromId]['role'];
        $targetRole = $role === 'sender' ? 'receiver' : 'sender';
        $target = $this->rooms[$pin][$targetRole];

        return $target instanceof ConnectionInterface ? $target : null;
    }

    private function generateUniquePin(): ?string
    {
        for ($i = 0; $i < 1000; $i++) {
            $pin = str_pad((string) random_int(0, 999999), 6, '0', STR_PAD_LEFT);
            if (!isset($this->rooms[$pin])) {
                return $pin;
            }
        }

        return null;
    }

    private function isValidPin(string $pin): bool
    {
        return preg_match('/^\d{6}$/', $pin) === 1;
    }

    private function send(ConnectionInterface $conn, array $message): void
    {
        $encoded = json_encode($message, JSON_UNESCAPED_SLASHES);
        if ($encoded === false) {
            return;
        }

        $conn->send($encoded);
    }

    private function sendError(ConnectionInterface $conn, string $message): void
    {
        $this->send($conn, [
            'type' => 'error',
            'message' => $message,
        ]);
    }
}

$loop = LoopFactory::create();
$socket = new SocketServer('0.0.0.0:8080', [], $loop);
$server = new IoServer(
    new HttpServer(new WsServer(new SignalingServer())),
    $socket,
    $loop
);

echo "Signaling server listening on ws://localhost:8080\n";
$loop->run();
