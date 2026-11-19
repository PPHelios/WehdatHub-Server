// lib/failureInfo.js — Severity and a plain-words explanation for a Failures row, in Arabic (Egyptian) and English.
// Severity: high = our fault (server error / swallowed error), medium = an action did not work, low = a normal refusal.
"use strict";

const SEVERITIES = ["high", "medium", "low"];

const HTTP = {
  400: ["medium", "الطلب ناقص أو فيه بيان غلط، فالسيستم رفضه.", "The request was incomplete or had a wrong value, so it was rejected."],
  401: ["low", "الجلسة خلصت أو المستخدم مش مسجّل دخول.", "The session ended or the user was not signed in."],
  402: ["medium", "الشركة وصلت للحد الأقصى في باقتها أو الاشتراك منتهي.", "The agency reached its plan limit or the subscription ended."],
  403: ["low", "المستخدم معندوش صلاحية للعملية دي.", "The user is not allowed to do this action."],
  404: ["low", "الحاجة المطلوبة مش موجودة (اتمسحت أو الرابط غلط).", "The requested item does not exist (deleted or wrong link)."],
  409: ["medium", "تعارض: الحاجة دي موجودة قبل كده أو اتغيّرت.", "Conflict: this already exists or was changed meanwhile."],
  413: ["medium", "الملف أكبر من المسموح.", "The file is too large."],
  422: ["medium", "البيانات مكتوبة صح لكن مخالفة لقاعدة (مثلاً رقم أو سعر مش مقبول).", "The data was well-formed but broke a rule (e.g. an invalid number or price)."],
  429: ["medium", "طلبات كتير في وقت قصير، السيستم هدّى المستخدم.", "Too many requests in a short time; the user was slowed down."]
};

const TYPES = {
  swallowed_error: ["high", "حصل خطأ جوّه السيستم وكمّل شغله بقيمة بديلة. محتاج مراجعة من المطوّر.", "An internal error happened and the system carried on with a fallback. A developer should look."],
  unit_write_refused: ["low", "إضافة أو تعديل وحدة اترفض بالسبب المكتوب.", "Adding or editing a unit was refused for the reason shown."]
};

/** @returns {{ severity: "high"|"medium"|"low", ar: string, en: string }} */
function describe(operationType, code) {
  if (TYPES[operationType]) {
    const [severity, ar, en] = TYPES[operationType];
    return { severity, ar, en };
  }
  const m = /^http_(\d{3})$/.exec(String(code || ""));
  if (m) {
    const status = Number(m[1]);
    if (HTTP[status]) {
      const [severity, ar, en] = HTTP[status];
      return { severity, ar, en };
    }
    if (status >= 500) return { severity: "high", ar: "السيرفر فشل في تنفيذ الطلب. ده خطأ من عندنا ومحتاج مراجعة.", en: "The server failed to complete the request. This is on us and needs a look." };
    return { severity: "medium", ar: "الطلب اترفض.", en: "The request was refused." };
  }
  return { severity: "medium", ar: "عملية فشلت، السبب مكتوب جنبها.", en: "An action failed; the reason is shown next to it." };
}

/** SQL expression giving the same severity as describe() for operation_logs alias `o`. */
const SEVERITY_SQL = `CASE
  WHEN o.operation_type = 'swallowed_error' OR o.error_code ~ '^http_5' THEN 'high'
  WHEN o.operation_type = 'unit_write_refused' OR o.error_code IN ('http_401','http_403','http_404') THEN 'low'
  ELSE 'medium' END`;

module.exports = { SEVERITIES, describe, SEVERITY_SQL };
