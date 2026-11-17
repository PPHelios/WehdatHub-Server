// domain/followUpDraft.js — The follow-up message draft (Release B, N2), pure: the facts a draft may use (the
// client's first name, what they asked for, the last call or viewing and the broker's notes on it, the stage), the
// prompt (in the broker's tone when they gave a sample; no prices, dates or promises that are not in the facts) and
// reading the answer.
"use strict";

const MAX_TEXT = 900;
const MAX_STYLE = 600;

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

/** One fact line per item, newest event first. */
function factsOf({ lead, events = [], requests = [], viewing = null, broker, agencyName, requestLine = (f) => JSON.stringify(f) }) {
  const lines = [
    `Client first name: ${firstName(lead.name) || "(unknown, greet without a name)"}`,
    `Client type: ${lead.kind}; stage: ${lead.stage}`,
    `Broker: ${broker.name || "the broker"}${agencyName ? ` from ${agencyName}` : ""}`
  ];
  for (const r of requests.slice(0, 2)) lines.push(`The client is looking for: ${requestLine(r.filters)}`);
  if (viewing) lines.push(`Latest viewing: unit ${viewing.code || "?"}${viewing.compound ? ` in ${viewing.compound}` : ""}${viewing.district ? `, ${viewing.district}` : ""} (${viewing.status || "scheduled"}, ${new Date(viewing.starts_at || viewing.created_at).toISOString().slice(0, 10)})`);
  for (const e of events.slice(0, 8)) {
    const d = e.data || {};
    const when = new Date(e.created_at).toISOString().slice(0, 10);
    if (e.kind === "note" && d.text) lines.push(`${when} broker's note: ${String(d.text).slice(0, 300)}`);
    else if (e.kind === "contacted") lines.push(`${when} the broker called the client`);
    else if (e.kind === "follow_up_done") lines.push(`${when} ${d.kind === "viewing" ? "viewing" : "follow-up call"} done${d.note ? `: ${String(d.note).slice(0, 200)}` : ""}`);
    else if (e.kind === "stage" && d.to) lines.push(`${when} stage changed to ${d.to}${d.lost_reason ? ` (${d.lost_reason})` : ""}`);
  }
  return lines;
}

/**
 * The message from a template, filled from the lead's own record (Parser consolidation, Phase 4: no AI call).
 * Arabic or English; the broker edits it before sending. Never states a price, date or promise.
 */
function template({ lead, events = [], requests = [], viewing = null, broker = {}, agencyName = "", lang = "ar", requestLine = () => "" }) {
  const en = lang === "en";
  const name = firstName(lead?.name);
  const kinds = events.map((e) => e.kind);
  const viewed = Boolean(viewing) || events.some((e) => e.kind === "follow_up_done" && e.data?.kind === "viewing");
  const called = kinds.includes("contacted") || events.some((e) => e.kind === "follow_up_done" && e.data?.kind !== "viewing");
  const req = requests.length ? String(requestLine(requests[0].filters) || "").trim() : "";
  const unit = viewing ? `${viewing.code || ""}${viewing.compound ? (en ? " in " : " في ") + viewing.compound : ""}`.trim() : "";
  const lost = lead?.stage === "lost";
  const open = en ? (name ? `Hi ${name},` : "Hello,") : name ? `أهلاً ${name}،` : "أهلاً بحضرتك،";
  let ctx;
  if (viewed) ctx = en ? `Thank you for your time at the viewing${unit ? ` of ${unit}` : ""}.` : `شكراً على وقتك في المعاينة${unit ? ` (${unit})` : ""}.`;
  else if (called) ctx = en ? "Thank you for our call." : "شكراً على مكالمتنا.";
  else if (lost) ctx = en ? "I wanted to check in in case you are still looking." : "حبيت أطمّن عليك لو لسه بتدور على وحدة.";
  else ctx = en ? "I wanted to follow up with you." : "حبيت أتابع معاك.";
  const ask = req ? (en ? `I am still working on what you asked for (${req}).` : `وأنا شغال على طلبك (${req}).`) : "";
  const next = viewed ? (en ? "Would you like to arrange another viewing?" : "تحب نحدد معاينة تانية؟") : lead?.stage === "negotiation" ? (en ? "Shall we go over the details together?" : "تحب نكمل في التفاصيل سوا؟") : en ? "When is a good time to talk?" : "إمتى يناسبك نتكلم؟";
  const sign = [broker.name, agencyName].filter(Boolean).join(en ? ", " : " - ");
  return [`${open} ${ctx}`, ask, next, sign].filter(Boolean).join("\n").slice(0, MAX_TEXT);
}

function prompt(facts, { lang, style = "" }) {
  const sample = String(style || "").trim().slice(0, MAX_STYLE);
  return `Write the next WhatsApp message from an Egyptian real-estate broker to their client, right after their last call or viewing.
Rules:
- Use ONLY the FACTS. Never invent prices, units, dates, discounts or promises. If a detail is not in the FACTS, leave it out.
- Short: 2 to 4 sentences, warm and professional, one clear next step (for example a question or offering another viewing).
- ${lang === "en" ? "Write in English." : "Write in Egyptian Arabic (عامية مصرية مهذبة)."}
- No internal notes the client should not read (commission, other clients, the broker's opinions of the client).
${sample ? `- Match the broker's own tone, as in this sample of how they write (do not copy its content):\n"""${sample}"""` : ""}
Return JSON only: {"text":"..."}

FACTS:
${facts.join("\n")}`;
}

function parse(text) {
  try {
    const d = JSON.parse(String(text || "").replace(/^```(?:json)?\s*|\s*```$/g, ""));
    const t = String(d.text || "").trim().slice(0, MAX_TEXT);
    return t ? { text: t } : { error: "empty" };
  } catch {
    return { error: "empty" };
  }
}

module.exports = { MAX_TEXT, MAX_STYLE, firstName, factsOf, template, prompt, parse };
