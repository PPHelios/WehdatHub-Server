// api/notifications.js — The app's notification inbox: the same list, read and delete the website's inbox uses
// (lib/notifications.js), so a notification deleted or read in one place is gone or read in the other.
"use strict";

const Notifications = require("../lib/notifications");

const PAGE = 20;

function register(api, { pool }) {
  // The broker's inbox, newest first. ?page=1.. ; `unread` is the badge number.
  api.get("/notifications", async (req, res) => {
    const { broker } = req.session;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const { rows, more } = await Notifications.listInbox(pool, broker, { limit: PAGE, offset: (page - 1) * PAGE });
    const unread = await Notifications.unreadCount(pool, broker);
    res.set("Cache-Control", "no-store");
    return res.json({
      items: rows.map((r) => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, url: r.url, created_at: r.created_at, read: Boolean(r.read_at) })),
      page,
      more,
      unread
    });
  });
  api.get("/notifications/unread-count", async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({ unread: await Notifications.unreadCount(pool, req.session.broker) });
  });
  // The "all" routes first: ":id" would otherwise swallow them.
  api.post("/notifications/read-all", async (req, res) => {
    await Notifications.markRead(pool, req.session.broker, "all");
    return res.json({ ok: true, unread: 0 });
  });
  api.post("/notifications/delete-all", async (req, res) => {
    await Notifications.dismiss(pool, req.session.broker, "all");
    return res.json({ ok: true, unread: 0 });
  });
  api.post("/notifications/:id/read", async (req, res) => {
    const hit = await Notifications.markRead(pool, req.session.broker, req.params.id);
    if (!hit) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, unread: await Notifications.unreadCount(pool, req.session.broker) });
  });
  api.post("/notifications/:id/delete", async (req, res) => {
    const ok = await Notifications.dismiss(pool, req.session.broker, Number(req.params.id) || 0);
    if (!ok) return res.status(404).json({ error: "not_found" });
    return res.json({ ok: true, unread: await Notifications.unreadCount(pool, req.session.broker) });
  });
}

module.exports = { register };
