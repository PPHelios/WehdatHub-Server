// domain/followUpDraft.js — The follow-up message draft (Release B, N2), pure: a template filled from the lead's own record
// (the client's first name, what they asked for, the last call or viewing, the stage). No AI.
"use strict";

const MAX_TEXT = 900;

const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

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
  const stage = lead?.stage;
  const open = en ? (name ? `Hi ${name},` : "Hello,") : name ? `أهلاً ${name}،` : "أهلاً بحضرتك،";
  let ctx;
  if (viewed) ctx = en ? `Thank you for your time at the viewing${unit ? ` of ${unit}` : ""}.` : `شكراً على وقتك في المعاينة${unit ? ` (${unit})` : ""}.`;
  else if (called) ctx = en ? "Thank you for our call." : "شكراً على مكالمتنا.";
  else if (lost) ctx = en ? "I wanted to check in in case you are still looking." : "حبيت أطمّن عليك لو لسه بتدور على وحدة.";
  else ctx = en ? "I wanted to follow up with you." : "حبيت أتابع معاك.";
  const ask = req && stage !== "won" ? (en ? `I am still working on what you asked for (${req}).` : `وأنا شغال على طلبك (${req}).`) : "";
  const next =
    stage === "won" ? (en ? "Congratulations, and thank you for your trust. I am here if you need anything." : "مبروك، وشكراً على ثقتك. أنا موجود لو احتجت أي حاجة.")
    : viewed ? (en ? "Would you like to arrange another viewing?" : "تحب نحدد معاينة تانية؟")
    : stage === "viewing" ? (en ? "Shall we confirm a time for the viewing?" : "تحب نأكد معاد المعاينة؟")
    : stage === "negotiation" ? (en ? "Shall we go over the details together?" : "تحب نكمل في التفاصيل سوا؟")
    : stage === "interested" ? (en ? "Shall I send you more options that fit?" : "تحب أبعتلك خيارات تانية مناسبة؟")
    : en ? "When is a good time to talk?" : "إمتى يناسبك نتكلم؟";
  const sign = [broker.name, agencyName].filter(Boolean).join(en ? ", " : " - ");
  return [`${open} ${ctx}`, ask, next, sign].filter(Boolean).join("\n").slice(0, MAX_TEXT);
}

module.exports = { MAX_TEXT, firstName, template };
