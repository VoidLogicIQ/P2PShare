# P2P Share

Browser-to-browser file transfer app using WebRTC DataChannel with 6-digit PIN pairing.

The file transfer is **P2P**.  
The server is used only for signaling (offer/answer/ICE), implemented via HTTPS PHP API polling.

## Features

- 6-digit PIN room pairing
- Sender/Receiver two-card UI
- Chunked file transfer (16 KB chunks)
- WebRTC DataChannel file transfer (server does not store files)
- Shared-hosting friendly signaling (`public/api.php`)
- No database (file-based signaling state)

## Project Structure

```text
/project-root
  /server
    composer.json
    signaling-server.php
  /public
    .htaccess
    api.php
    app.js
    index.html
    style.css
  README.md
```

## Requirements

- PHP 8+
- HTTPS in production
- Modern browser with WebRTC support

Notes:
- `localhost` is allowed for development.
- Production should be opened with `https://...`.

## Current Signaling Mode

Current app uses:

- `public/api.php` for signaling (`create-room`, `join-room`, `send-signal`, `poll`, `leave`)
- File-backed room state at `server/storage/rooms.json` (auto-created)

You do **not** need to run `server/signaling-server.php` for this mode.

## Local Run (Quick Test)

From project root:

```bash
php -S localhost:8000 -t public
```

Open:

```text
http://localhost:8000/index.html
```

Use two tabs or two devices:

1. Sender: choose file, click `Generate PIN`
2. Receiver: enter PIN, click `Connect`
3. Receiver gets auto-download when complete

## Shared Hosting Deployment (Bluehost/cPanel)

1. Upload project files.
2. Ensure this folder is web accessible:
   - `.../P2PShare/public/`
3. Open app from:
   - `https://your-domain/P2PShare/public/index.html`
4. Ensure PHP can create/write:
   - `server/storage/rooms.json`
   - and `server/storage/` directory

## API Endpoints (internal)

All requests are `POST` JSON to `public/api.php`.

Actions:

- `create-room`
- `join-room`
- `send-signal`
- `poll`
- `leave`

## Security and Validation

- PIN must be exactly 6 numeric digits
- Peer IDs are random 32-hex tokens
- JSON parsing and action validation
- File transfer stays peer-to-peer over DataChannel
- Stale peer/room cleanup in signaling storage

## Troubleshooting

### Error: `Could not connect to ws://localhost:8080`

You are running an old `app.js`.  
Verify deployed `app.js` starts with:

```js
const SIGNALING_ENDPOINT = "api.php";
```

If it contains `SIGNALING_URL` or `ws://localhost:8080`, replace it with the latest file and hard refresh (`Ctrl+F5`).

### `api.php` returns 405 in browser

Normal. `api.php` only accepts `POST` JSON from the app.

### Peers fail to connect

- Verify both users are on HTTPS
- Check browser console for ICE errors
- Some strict NAT networks may need a TURN server (current config uses public STUN)
