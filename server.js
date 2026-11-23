// Pebble Apps proxy (Render version, plain Node, no dependencies)
// Set the robot's "Pebble server" to this service's https URL.
//  - GET /stackChan/apps  -> Pebble's own app list + the apps in apps.json
//  - everything else      -> forwarded unchanged to Pebble's cloud (HTTP and WebSocket)
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const fs = require("node:fs");
const path = require("node:path");

const PEBBLE_HOST = "app.pebblerobo.com";
const PORT = process.env.PORT || 10000;
const extraApps = JSON.parse(fs.readFileSync(path.join(__dirname, "apps.json"), "utf8"));

// Same field aliases the robot's firmware accepts.
const pick = (o, keys) => keys.map((k) => o?.[k]).find((v) => typeof v === "string");
const normalise = (app) => ({
  ...app,
  appName: pick(app, ["appName", "name"]),
  iconUrl: pick(app, ["iconUrl", "appIconUrl", "appIcon", "icon"]),
  description: pick(app, ["description", "appDescription", "desc"]) ?? "",
  firmwareUrl: pick(app, ["firmwareUrl", "downloadUrl", "otaUrl", "url"]),
});

function upstreamHeaders(req) {
  const h = { ...req.headers, host: PEBBLE_HOST };
  for (const k of Object.keys(h)) if (k.startsWith("x-forwarded") || k.startsWith("rndr-") || k === "true-client-ip") delete h[k];
  return h;
}

function forward(req, res) {
  const up = https.request(
    { host: PEBBLE_HOST, port: 443, method: req.method, path: req.url, headers: upstreamHeaders(req) },
    (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    }
  );
  up.on("error", (e) => {
    console.error("forward error", req.method, req.url, e.message);
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: 502, message: "Pebble cloud unreachable" }));
  });
  req.pipe(up);
}

function fetchPebbleApps(req) {
  return new Promise((resolve) => {
    const h = upstreamHeaders(req);
    delete h["accept-encoding"]; // we parse the body ourselves
    const up = https.request({ host: PEBBLE_HOST, port: 443, method: "GET", path: req.url, headers: h, timeout: 8000 }, (r) => {
      let body = "";
      r.setEncoding("utf8");
      r.on("data", (c) => (body += c));
      r.on("end", () => {
        try {
          const j = JSON.parse(body);
          resolve(Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []);
        } catch { resolve([]); }
      });
    });
    up.on("timeout", () => up.destroy());
    up.on("error", () => resolve([]));
    up.end();
  });
}

async function appList(req, res) {
  const pebbleApps = await fetchPebbleApps(req);
  const seen = new Set();
  const data = [...pebbleApps, ...extraApps]
    .map(normalise)
    .filter((a) => a.appName && a.firmwareUrl && !seen.has(a.appName) && seen.add(a.appName));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ code: 0, message: "OK", data }));
}

const server = http.createServer((req, res) => {
  const p = req.url.split("?")[0].replace(/\/+$/, "");
  if (p === "/_worker/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, extraApps: extraApps.length, forwardsTo: `https://${PEBBLE_HOST}` }));
  }
  if (req.method === "GET" && p === "/stackChan/apps") return appList(req, res);
  forward(req, res);
});

// WebSocket (and any other Upgrade): open TLS to Pebble, replay the handshake, then pipe both ways.
server.on("upgrade", (req, socket, head) => {
  const up = tls.connect({ host: PEBBLE_HOST, port: 443, servername: PEBBLE_HOST }, () => {
    const h = upstreamHeaders(req);
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [k, v] of Object.entries(h)) for (const val of [].concat(v)) raw += `${k}: ${val}\r\n`;
    up.write(raw + "\r\n");
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  const close = () => { up.destroy(); socket.destroy(); };
  up.on("error", (e) => { console.error("ws upstream error", e.message); close(); });
  socket.on("error", close);
  up.on("close", close);
  socket.on("close", close);
});

server.keepAliveTimeout = 120000;
server.listen(PORT, () => console.log(`pebble-apps proxy on :${PORT} -> https://${PEBBLE_HOST}, ${extraApps.length} extra apps`));
