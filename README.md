# P2P Share

P2P Share is a browser-to-browser file transfer app using WebRTC DataChannel and 6-digit PIN pairing.

The actual file data is transferred peer-to-peer.  
The PHP backend is used only for signaling (`offer`, `answer`, `ice-candidate`) over HTTPS.

## Features

- 6-digit PIN room pairing
- Sender and Receiver two-card UI
- Chunked transfer (16 KB chunks)
- WebRTC DataChannel P2P transfer
- HTTPS signaling API with PHP (`public/api.php`)
- No database (file-based room/signaling state)
- Installable PWA (Chrome/Edge)

## Tech Stack

- Frontend: HTML, CSS, Vanilla JavaScript
- P2P Transport: WebRTC (`RTCPeerConnection`, `RTCDataChannel`)
- Signaling: PHP 8+ JSON API (`fetch` polling)
- STUN: `stun:stun.l.google.com:19302`

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
- Modern browser with WebRTC support
- HTTPS for non-localhost usage

## HTTPS Requirement

This app requires a secure context for WebRTC:

- `https://...` is required for normal usage
- `http://localhost` is allowed for local development

The included `public/.htaccess` redirects HTTP to HTTPS on Apache (when rewrite is enabled).

## Install as App (PWA)

On Chrome/Edge (desktop or Android):

1. Open the app over `https://`.
2. Wait a few seconds for service worker and manifest to load.
3. Use browser menu:
   - Android Chrome: `Add to Home screen` / `Install app`
   - Desktop Chrome: `Install P2P Share` in address bar or menu

PWA files:

- `public/manifest.webmanifest`
- `public/sw.js`
- `public/icons/icon-192.png`
- `public/icons/icon-512.png`

## Run Locally

From project root:

```bash
php -S localhost:8000 -t public
```

Open:

```text
http://localhost:8000/index.html
```

## How to Use

1. Open the app on two browsers/devices.
2. Sender:
   - Select a file.
   - Click `Generate PIN`.
3. Receiver:
   - Enter the 6-digit PIN.
   - Click `Connect`.
4. Transfer starts once the WebRTC DataChannel is connected.
5. Receiver download triggers automatically when transfer completes.

## Signaling API (Internal)

Endpoint:

- `POST public/api.php`

Actions:

- `create-room`
- `join-room`
- `send-signal`
- `poll`
- `leave`

Signaling state is stored in:

- `server/storage/rooms.json` (created automatically)

## Notes

- `server/signaling-server.php` is the legacy WebSocket signaling server and is not required for the current HTTPS signaling mode.
- Server never stores transferred file data.

## Troubleshooting

### Still seeing `ws://localhost:8080` error

You are running an old `public/app.js`.  
The current file starts with:

```js
const SIGNALING_ENDPOINT = "api.php";
```

Hard refresh after deploying (`Ctrl+F5`).

### `api.php` returns 405 in browser

Expected behavior. `api.php` only accepts `POST` requests.

### Connection fails between peers

- Ensure both peers open the app over HTTPS (or localhost for local testing).
- Check browser console for ICE/WebRTC errors.
- Some strict NAT environments may require a TURN server.
