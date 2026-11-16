// lib/channels/text.js — The plain text of a notification (title, body, and the website link when there is one)
"use strict";

const Links = require("../links");

/** The text of a notification: title, body, and the website link when there is one. */
function textOf(message) {
  const lines = [message.title];
  if (message.body) lines.push(message.body);
  if (message.url) lines.push(`🌐 ${Links.appUrl(message.url.replace(/^\/app\/?/, "/"))}`);
  return lines.join("\n");
}

module.exports = { textOf };
