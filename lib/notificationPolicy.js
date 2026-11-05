// lib/notificationPolicy.js — Who decides how each notification reaches a person.
//
// The agency has one policy, per notification kind: on or off, a channel, a frequency (immediate, hourly, daily) and an
// optional lock. A locked setting is forced for everyone. An unlocked setting is the team's default, which the person can
// change for themselves. The owner can lock anything; a manager can lock only what the owner has not locked, and the
// owner's lock overrides a manager's. A person's own choice applies only where the policy leaves it to them.
// Urgent kinds (a lead assigned, a follow-up or viewing due, a hot client, manager alerts, system alerts) are always on and
// immediate; the person still picks their channel for them, unless the owner or a manager locks it.
"use strict";

const { getConfig } = require("../config");

const URGENT_KINDS = ["assignment", "follow_up", "hot_client", "manager_alert", "system_alert"];
const FREQUENCIES = ["immediate", "hourly", "daily"];
const CHANNELS = ["both", "telegram", "web", "whatsapp"];
const LOCKERS = ["owner", "manager"];

const isOwnerRole = (b) => String(b?.role || "").toLowerCase() === "owner";
const isUrgent = (kind) => URGENT_KINDS.includes(kind);

/** Only known values survive; anything else is dropped. */
function cleanEntry(e = {}) {
  const out = {};
  if (typeof e.on === "boolean") out.on = e.on;
  if (CHANNELS.includes(e.channel)) out.channel = e.channel;
  if (FREQUENCIES.includes(e.frequency)) out.frequency = e.frequency;
  if (LOCKERS.includes(e.lock)) out.lock = e.lock;
  return out;
}

/** The agency's policy as stored: { kind: { on?, channel?, frequency?, lock? } }. */
function policyOf(agency) {
  const raw = agency?.notify_policy || {};
  const out = {};
  for (const [kind, e] of Object.entries(raw)) out[kind] = cleanEntry(e);
  return out;
}

/** Whether `actor` may save this entry over the current one: the owner always; a manager only over an unlocked or manager-locked entry. */
function mayChange(actor, current = {}) {
  if (isOwnerRole(actor)) return true;
  return current.lock !== "owner";
}

/**
 * Saves one or more entries. A manager cannot touch an owner's lock; the owner can. Returns { ok, policy } or { error }.
 * changes: { kind: { on, channel, frequency, lock } }; a null value clears the entry.
 */
function merge(policy, actor, changes = {}) {
  const next = { ...policy };
  for (const [kind, change] of Object.entries(changes)) {
    if (!isUrgent(kind) && !KNOWN_KINDS.includes(kind)) return { error: "kind" };
    const current = next[kind] || {};
    if (!mayChange(actor, current)) return { error: "owner_locked", kind };
    if (change === null) {
      delete next[kind];
      continue;
    }
    const cleaned = cleanEntry(change);
    // Urgent kinds stay on and immediate: the policy cannot switch them off or batch them.
    if (isUrgent(kind)) {
      delete cleaned.on;
      delete cleaned.frequency;
    }
    next[kind] = cleaned;
  }
  return { ok: true, policy: next };
}

const KNOWN_KINDS = ["assignment", "follow_up", "match", "share_opened", "hot_client", "manager_alert", "team_activity", "system_alert"];

/**
 * The effective setting for one person and one kind: { enabled, channel, frequency, locked: "owner"|"manager"|null,
 * lockedFields: [...] }. `mine` is the person's own choice: { on?, channel?, frequency? } (missing means "not chosen").
 */
function resolve(policy, mine = {}, kind) {
  const p = policy[kind] || {};
  const lockedFields = p.lock ? ["on", "channel", "frequency"].filter((f) => (f === "on" ? p.on !== undefined : p[f] !== undefined)) : [];
  const locked = p.lock || null;
  const pick = (field, fallback) => (locked && p[field] !== undefined ? p[field] : mine[field] !== undefined ? mine[field] : p[field] !== undefined ? p[field] : fallback);
  const urgent = isUrgent(kind);
  return {
    enabled: urgent ? true : pick("on", true),
    channel: pick("channel", null),
    frequency: urgent ? "immediate" : pick("frequency", "immediate"),
    locked,
    lockedFields
  };
}

/** The next moment a batch is sent: hourly at the top of the next hour; daily at 09:00 Cairo (today if still before it). */
function nextBatchAt(frequency, now = new Date()) {
  if (frequency === "hourly") return new Date(Math.floor(now.getTime() / 3600000) * 3600000 + 3600000);
  if (frequency === "daily") {
    const Stages = require("../domain/leadStages");
    const today9 = Stages.cairoDayAt(now, 0, 9);
    return today9 > now ? today9 : Stages.cairoDayAt(now, 1, 9);
  }
  return now;
}

/** The policy's own URL-free summary for one kind, for the team page. */
function describe(entry = {}) {
  return { ...entry, forced: Boolean(entry.lock) };
}

module.exports = { URGENT_KINDS, FREQUENCIES, CHANNELS, LOCKERS, KNOWN_KINDS, isUrgent, cleanEntry, policyOf, mayChange, merge, resolve, nextBatchAt, describe, getConfig };
