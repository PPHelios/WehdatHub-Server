// lib/waOwnerOnly.js — WhatsApp is for the CRM owner's number only, and only for two things: the sign-in link
// ("login") and help. Every other sender is ignored (no reply, nothing stored), and nothing is sent on WhatsApp to any
// other number. Telegram and the website are unaffected. The number: WHATSAPP_ALLOWED_NUMBER (default 01055881114).
"use strict";

const config = require("../config");

const digits = (raw) => String(raw || "").replace(/\D/g, "");
const isOwnerNumber = (raw) => {
  const d = digits(raw);
  return Boolean(d) && d === config.getConfig().whatsapp.ownerNumber;
};

// The same words the router uses for sign-in (lib/registry.js WEB_LOGIN) and for help (lib/leadIntake.js HELP).
const HELP = /^(مساعدة|help|اوامر|الأوامر|menu|قائمة)$/i;

/** Whether an inbound message may be handled: the owner's number, a text, and only login or help. */
function inboundAllowed(message) {
  if (!config.getConfig().whatsapp.ownerOnly) return true;
  if (!message || !isOwnerNumber(message.from) || message.type !== "text") return false;
  const text = String(message.text?.body || "").trim().replace(/\s+/g, " ");
  const { WEB_LOGIN } = require("./registry");
  return WEB_LOGIN.test(text) || HELP.test(text);
}

const TRIAL_VERIFY_RE = /^VERIFY\s+(su_[A-Za-z0-9_-]{20,60})$/i;
const trialReplyUntil = new Map();

function extractTrialVerifyToken(message) {
  if (!message || message.type !== "text") return null;
  const m = String(message.text?.body || "").trim().match(TRIAL_VERIFY_RE);
  return m ? m[1] : null;
}

function allowTrialReply(to, ttlMs = 120000) {
  const d = digits(to);
  if (d) trialReplyUntil.set(d, Date.now() + ttlMs);
}

/** Whether an outbound WhatsApp send may go to this recipient: owner's number, or a 2-min trial-OTP reply window. */
function outboundAllowed(to) {
  if (!config.getConfig().whatsapp.ownerOnly || isOwnerNumber(to)) return true;
  const d = digits(to);
  const exp = d ? trialReplyUntil.get(d) : 0;
  if (exp && exp > Date.now()) return true;
  if (d && exp) trialReplyUntil.delete(d);
  return false;
}

module.exports = { inboundAllowed, outboundAllowed, isOwnerNumber, extractTrialVerifyToken, allowTrialReply, HELP };
