# pebble-apps-render

Small proxy for a PebbleRobo (StackChan-based robot).

Set the robot's **Pebble server** (Wi-Fi setup → Advanced) to this service's `https://…onrender.com` URL.

- `GET /stackChan/apps` → Pebble's own App Center list **plus** the apps in `apps.json`
- everything else (HTTP and WebSocket) → forwarded unchanged to `https://app.pebblerobo.com`
- `GET /_worker/health` → status check

Why Render and not Cloudflare Workers: the robot's TLS stack only supports RSA certificates; `*.workers.dev` serves ECDSA only.

`firmwareUrl` entries must stay `http://`: the robot's App Center update code pins one test certificate, so `https` downloads from other hosts fail.

To add an app: add an entry to `apps.json`, commit, push — Render redeploys automatically.
