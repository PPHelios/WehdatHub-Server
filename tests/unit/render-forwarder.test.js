// tests/unit/render-forwarder.test.js — the temporary Render forwarder passes requests through unchanged.
const http = require("node:http");
const { createForwarder } = require("../../scripts/render-forwarder");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
}

let upstream, forwarder, base, seen;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen = { method: req.method, url: req.url, auth: req.headers.authorization, host: req.headers["x-forwarded-host"], body };
      if (req.url === "/moved") {
        res.writeHead(302, { location: "/app/login" });
        return res.end();
      }
      res.setHeader("set-cookie", ["a=1; Path=/", "b=2; Path=/"]);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const target = await listen(upstream);
  forwarder = createForwarder(target);
  base = await listen(forwarder);
});

afterAll(() => {
  upstream.close();
  forwarder.close();
});

test("POST keeps method, path, query, auth header and body; status, cookies and body come back", async () => {
  const res = await fetch(`${base}/api/v1/units?x=1`, {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: JSON.stringify({ a: 1 })
  });
  expect(res.status).toBe(201);
  expect(await res.json()).toEqual({ ok: true });
  expect(res.headers.getSetCookie()).toEqual(["a=1; Path=/", "b=2; Path=/"]);
  expect(seen).toMatchObject({ method: "POST", url: "/api/v1/units?x=1", auth: "Bearer t", body: '{"a":1}' });
  expect(seen.host).toMatch(/^127\.0\.0\.1:/);
});

test("redirects are passed through, not followed", async () => {
  const res = await fetch(`${base}/moved`, { redirect: "manual" });
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/app/login");
});

test("answers 502 when the new site is unreachable", async () => {
  const down = createForwarder("http://127.0.0.1:1");
  const url = await listen(down);
  const res = await fetch(`${url}/health`);
  expect(res.status).toBe(502);
  down.close();
});
