// scripts/render-forwarder.js — Temporary stand-in for the old Render service after the move to OCI.
// The released mobile app and links already sent to clients still use https://wehdathub.onrender.com, so this
// forwards every request unchanged (method, path, headers, body) to the new site and streams the answer back.
// No database, no bot token, no jobs: it never registers the Telegram webhook.
// Render start command: node scripts/render-forwarder.js   (FORWARD_TO defaults to https://wehdathub.com)
// shortcut: all forwarded users share Render's IP for the app's per-IP rate limits; delete this service once
// APP_MIN_VERSION forces the app build that talks to wehdathub.com directly.
"use strict";

const http = require("node:http");
const { Readable } = require("node:stream");

const TARGET = String(process.env.FORWARD_TO || "https://wehdathub.com").replace(/\/+$/, "");
// Hop-by-hop headers (RFC 9110 7.6.1) plus the ones fetch sets itself.
const DROP_REQUEST = new Set(["host", "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "content-length"]);
// fetch already decoded the body, so the encoding and length of the original no longer apply.
const DROP_RESPONSE = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"]);

function forwardHeaders(req) {
  const out = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (DROP_REQUEST.has(name) || value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.append(name, v);
  }
  out.set("x-forwarded-host", String(req.headers.host || ""));
  out.set("x-forwarded-proto", "https");
  return out;
}

function createForwarder(target = TARGET, fetchImpl = fetch) {
  return http.createServer(async (req, res) => {
    const hasBody = !["GET", "HEAD"].includes(req.method);
    try {
      const upstream = await fetchImpl(target + req.url, {
        method: req.method,
        headers: forwardHeaders(req),
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? "half" : undefined,
        redirect: "manual"
      });
      const headers = {};
      upstream.headers.forEach((value, name) => {
        if (!DROP_RESPONSE.has(name) && name !== "set-cookie") headers[name] = value;
      });
      const cookies = upstream.headers.getSetCookie?.() || [];
      if (cookies.length) headers["set-cookie"] = cookies;
      res.writeHead(upstream.status, headers);
      if (!upstream.body || req.method === "HEAD") return res.end();
      Readable.fromWeb(upstream.body).on("error", () => res.destroy()).pipe(res);
    } catch (err) {
      console.error(`[FORWARD] ${req.method} failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      res.end("Temporarily unavailable");
    }
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createForwarder().listen(port, () => console.log(`[FORWARD] port ${port} -> ${TARGET}`));
}

module.exports = { createForwarder, forwardHeaders };
