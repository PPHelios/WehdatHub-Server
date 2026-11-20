// web/routes/catalogue.js — The developer catalogue (Release A, C1): /app/catalogue lists the agency's projects and
// developers; /app/catalogue/projects/:id holds a project's details, phases, payment plans, materials and units.
// Managers edit, brokers read (no developer contact, no internal notes). services/catalogue.js does the work.
"use strict";

const Catalogue = require("../../services/catalogue");
const PlanRules = require("../../services/planRules");
const F = require("../../lib/financials");
const Commission = require("../../domain/commission");
const { isManager } = require("../../lib/authz");
const PriceSheets = require("../../services/priceSheets");
const Commissions = require("../../services/commissions");
const { termsSection } = require("./commissions");
const { pricesSection, pricesNotice } = require("./priceSheets");
const PriceReading = require("../../services/priceReading");
const { highlightsSection } = require("./brochure");
const { gallerySection } = require("./gallery");
const Gallery = require("../../services/projectGallery");
const PlanReading = require("../../services/planReading");
const PR = require("../../domain/planReading");
const RateLimit = require("../../lib/rateLimit");
const Clarify = require("../../domain/projectClarify");
const { html } = require("../html");
const { tabs } = require("../views/tabs");
const { uploads } = require("../uploads");
const Session = require("../session");
const Suggest = require("../../services/placeSuggest");
const ProjectPaste = require("../../services/projectPaste");
const ProjectSearch = require("../../services/projectSearch");
const ProjectRows = require("../../services/projectRows");
const Features = require("../../domain/features");
const Storage = require("../../lib/supabase");
const { projectForm } = require("../views/projectForm");
const { listPage } = require("../views/catalogueList");
const { carousel } = require("../views/carousel");

// F20: brochures, layouts and plan files kept in storage (PDF or photo).
const FILE = { name: "file", maxCount: 1, accept: /^(application\/pdf|image\/(jpeg|png|webp))$/ };
const uploadFile = uploads([FILE], { maxMb: Catalogue.MAX_FILE_MB });
// A new project may come with photos (the carousel), a brochure file and a link.
const PHOTOS = { name: "doc", maxCount: 10, accept: /^image\/(jpeg|png|webp)$/ };
const uploadNew = uploads([FILE, PHOTOS], { maxMb: Catalogue.MAX_FILE_MB });
const PLANS_DOC = { name: "doc", maxCount: PR.MAX_PAGES, accept: /^(application\/pdf|image\/(jpeg|png|webp|heic|heif)|text\/(csv|plain|comma-separated-values)|application\/(vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|vnd\.ms-excel|csv|octet-stream|zip))$/ };
const uploadPlansDoc = uploads([PLANS_DOC], { maxMb: 25 });
for (const re of [/^\/catalogue\/projects$/, /^\/catalogue\/projects\/[^/]+\/materials\/upload$/, /^\/catalogue\/projects\/[^/]+\/plans\/read$/]) Session.allowMultipart(re);

// F21: reading a developer's payment plans file.
const PLAN_READ_ERRORS = {
  OFF: ["قراءة الملفات مش مفعّلة لشركتك.", "Document reading isn't switched on for your agency."],
  NO_FILE: ["اختار ملف.", "Choose a file."],
  ONE_PDF: ["ملف واحد بس في المرة (أو صور).", "One file at a time (or photos)."],
  NOT_PDF: ["الملف ده مش PDF مقروء.", "That file isn't a readable PDF."],
  NOT_XLSX: ["الشيت لازم يكون .xlsx أو CSV.", "The sheet must be .xlsx or CSV."],
  TOO_LARGE: ["الشيت أكبر من 5 ميجا.", "The sheet is larger than 5 MB."],
  NOT_SUPPORTED: ["PDF أو صور أو إكسيل بس.", "A PDF, photos or an Excel sheet only."],
  pages_required: ["اكتب أرقام الصفحات (مثلاً 1-3).", "Enter the page numbers (e.g. 1-3)."],
  pages_invalid: ["أرقام الصفحات مش مظبوطة.", "The page numbers aren't valid."],
  too_many_pages: [`${PR.MAX_PAGES} صفحات بالكتير.`, `At most ${PR.MAX_PAGES} pages.`],
  ALLOWANCE: ["رصيد الشهر مش كفاية.", "This month's credits aren't enough."],
  AI_FAILED: ["القراءة فشلت؛ جرب تاني.", "Reading failed; try again."],
  NO_PLANS: ["ملقيناش أنظمة سداد في الملف.", "No payment plans found in the file."]
};

/** The plans file reader (managers, when document reading is on) and the preview to tick, edit and save. */
function plansReadSection(lang, project, reading, query = {}) {
  const base = `/app/catalogue/projects/${project.id}`;
  const draft = project.plans_draft;
  const err = query.plans_error ? PLAN_READ_ERRORS[query.plans_error] || PLAN_READ_ERRORS.AI_FAILED : null;
  const notice = err
    ? html`<p class="notice bad" role="alert">❌ ${err[lang === "en" ? 1 : 0]}${query.plans_error === "ALLOWANCE" ? L(lang, ` محتاج ${Number(query.needed) || 0} وفاضل ${Number(query.left) || 0}.`, ` Needs ${Number(query.needed) || 0}, ${Number(query.left) || 0} left.`) : ""}</p>`
    : query.plans_saved
      ? html`<p class="notice ok" role="status">✅ ${L(lang, `اتحفظ ${Number(query.plans_saved) || 0} نظام.`, `${Number(query.plans_saved) || 0} plan(s) saved.`)}${query.plans_failed ? html` ❌ ${L(lang, "مااتحفظش", "Not saved")}: ${String(query.plans_failed).slice(0, 200)}` : ""}</p>`
      : "";
  const preview = draft?.plans?.length
    ? html`<form method="post" action="${base}/plans/draft/apply" class="stack" data-plans-draft>
    <p>🤖 ${L(lang, `أنظمة اتقرت من ${draft.file_name}. علّم اللي عايزه، عدّل لو محتاج، واحفظ.`, `Plans read from ${draft.file_name}. Tick the ones you want, edit if needed, and save.`)}</p>
    ${draft.plans.map((pl, i) => html`<fieldset data-draft-plan="${i}"><legend><label><input type="checkbox" name="pick" value="${i}" checked> ${pl.name}</label></legend>
      <div class="row">
        <label>${L(lang, "الاسم", "Name")} <input name="name_${i}" maxlength="80" value="${pl.name}"></label>
        <label>${L(lang, "المقدم %", "Down %")} <input name="down_${i}" inputmode="decimal" dir="ltr" size="4" value="${val(pl.down_payment_pct)}"></label>
        <label>${L(lang, "سنين", "Years")} <input name="years_${i}" inputmode="decimal" dir="ltr" size="3" value="${val(pl.years)}"></label>
        <label>${L(lang, "القسط", "Installments")} <select name="frequency_${i}">${Catalogue.FREQUENCIES.map((f) => html`<option value="${f}"${sel(pl.frequency === f)}>${label2(FREQ, f, lang)}</option>`)}</select></label>
        <label>${L(lang, "خصم %", "Discount %")} <input name="discount_${i}" inputmode="decimal" dir="ltr" size="4" value="${val(pl.discount_pct)}"></label>
        <label>${L(lang, "الصيانة %", "Maintenance %")} <input name="maintenance_${i}" inputmode="decimal" dir="ltr" size="4" value="${val(pl.maintenance_pct)}"></label>
      </div>
      <p class="muted">${planLine(pl, lang)}</p></fieldset>`)}
    <div class="row"><button type="submit">${L(lang, "احفظ المعلّم", "Save ticked plans")}</button>
    <button type="submit" class="secondary" formaction="${base}/plans/draft/discard" data-confirm="${L(lang, `تتجاهل مسودة أنظمة السداد؟ مش هينفع ترجع.`, `Discard the payment plan draft? This can't be undone.`)}">${L(lang, "تجاهل", "Discard")}</button></div>
  </form>`
    : "";
  const form = reading?.enabled
    ? html`<form method="post" action="${base}/plans/read" enctype="multipart/form-data" class="stack" data-plans-read>
    <label>🤖 ${L(lang, "حمل ملف أنظمة السداد من المطور (PDF أو صور أو إكسيل)", "Upload the developer's payment plans file (PDF, photos or Excel)")} <input type="file" name="doc" accept="application/pdf,image/jpeg,image/png,image/webp,.xlsx,.csv" multiple required></label>
    <label>${L(lang, "الصفحات (للـ PDF)", "Pages (for a PDF)")} <input name="pages" dir="ltr" placeholder="1-3" maxlength="40"></label>
    <p class="muted">${L(lang, `${PR.MAX_PAGES} صفحات بالكتير (الشيت بصفحة)، من صفحات الشهر (فاضل ${reading.left}). مفيش حاجة بتتحفظ قبل ما تراجع. الملف بيتحفظ في الملفات (داخلي).`, `At most ${PR.MAX_PAGES} pages (a sheet counts as one), from this month's pages (${reading.left} left). Nothing is saved until you check it. The file is kept under Materials (internal).`)}</p>
    <button type="submit" class="secondary">${L(lang, "اقرا الأنظمة", "Read the plans")}</button>
  </form>`
    : "";
  return notice || preview || form ? html`<section class="card stack" id="plans-read">${notice}${preview}${form}</section>` : "";
}


const { L } = require("../../lib/copy");
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const sel = (on) => (on ? html` selected` : "");
const val = (v) => (v === null || v === undefined ? "" : String(Number.isFinite(Number(v)) && typeof v !== "string" ? Number(v) : v));
const pctText = (v) => (v === null || v === undefined ? "—" : `${Number(v)}%`);

const STATUS = {
  launching: ["🚀 إطلاق", "🚀 Launching"],
  selling: ["🟢 متاح للبيع", "🟢 Selling"],
  sold_out: ["⚪ اتباع بالكامل", "⚪ Sold out"]
};
const KIND = {
  master_plan: ["المخطط العام", "Master plan"],
  brochure: ["البروشور", "Brochure"],
  layout: ["مخطط وحدة", "Unit layout"],
  video: ["فيديو", "Video"],
  location: ["اللوكيشن", "Location pin"],
  website: ["موقع المطور", "Developer website"],
  price_sheet: ["شيت الأسعار (داخلي)", "Price sheet (internal)"],
  other: ["تاني", "Other"]
};
const FREQ = {
  monthly: ["شهري", "Monthly"],
  quarterly: ["ربع سنوي", "Quarterly"],
  semi_annual: ["كل 6 شهور", "Every 6 months"],
  annual: ["سنوي", "Yearly"]
};
const DUE = { delivery: ["عند الاستلام", "At delivery"], installments: ["مقسمة على الأقساط", "Split over installments"], contract: ["عند التعاقد", "At contract"] };
const FIELD = {
  name: ["اكتب الاسم.", "Type the name."],
  status: ["اختار الحالة.", "Pick a status."],
  delivery_year: ["سنة الاستلام لازم تكون رقم زي 2028.", "The delivery year must be like 2028."],
  delivery_quarter: ["الربع من 1 لـ 4.", "The quarter is 1 to 4."],
  maintenance_pct: ["الصيانة نسبة من 0 لـ 30.", "Maintenance is a % from 0 to 30."],
  developer_id: ["المطور ده مش موجود.", "That developer was not found."],
  place: ["اختار المكان (كمبوند أو منطقة).", "Pick the place (a compound or an area)."],
  price_from: ["السعر لازم يكون رقم.", "The price must be a number."],
  area_acres: ["المساحة (فدان) لازم تكون رقم.", "The size (feddan) must be a number."],
  down_pct_min: ["المقدم نسبة من 0 لـ 100.", "The down payment is a % from 0 to 100."],
  years_max: ["السنين من 0 لـ 20.", "Years are 0 to 20."],
  bedrooms: ["عدد الغرف من 1 لـ 9.", "Bedrooms are 1 to 9."],
  property_types: ["نوع وحدة مش معروف.", "An unknown unit type."],
  pin: ["لينك اللوكيشن مش مظبوط.", "The location link looks wrong."],
  contact_phone: ["رقم التليفون مش مظبوط.", "The phone number looks wrong."],
  phase_name: ["اكتب اسم المرحلة (ومايتكررش).", "Type the phase name (not used already)."],
  phase_status: ["اختار حالة المرحلة.", "Pick the phase status."],
  phase_delivery_year: ["سنة الاستلام لازم تكون رقم زي 2028.", "The delivery year must be like 2028."],
  phase_delivery_quarter: ["الربع من 1 لـ 4.", "The quarter is 1 to 4."],
  phase_id: ["المرحلة دي مش موجودة.", "That phase was not found."],
  plan_name: ["اكتب اسم النظام.", "Type the plan name."],
  down_payment_pct: ["المقدم نسبة من 0 لـ 100.", "The down payment is a % from 0 to 100."],
  years: ["عدد السنين من 0 لـ 20.", "Years are 0 to 20."],
  frequency: ["اختار كل قد إيه القسط.", "Pick how often installments are paid."],
  discount_pct: ["الخصم نسبة من 0 لـ 100.", "The discount is a % from 0 to 100."],
  maintenance_due: ["اختار ميعاد الصيانة.", "Pick when maintenance is due."],
  maintenance_splits: ["عدد دفعات الصيانة من 1 لـ 12.", "Maintenance splits are 1 to 12."],
  milestones: ["الدفعات: نسبة وشهر لكل دفعة، والمقدم والدفعات مايزيدوش عن 100%.", "Milestones: a % and a month each; down payment plus milestones must not exceed 100%."],
  extra_fees: ["المصاريف الإضافية: اسم ومبلغ لكل واحدة.", "Extra fees: a label and an amount each."],
  label: ["اكتب اسم اللينك.", "Type the link's label."],
  kind: ["اختار نوع اللينك.", "Pick the link type."],
  url: ["اللينك لازم يبدأ بـ https://", "The link must start with https://"],
  codes: ["اكتب كود وحدة واحد على الأقل.", "Type at least one unit code."],
  file: ["الملف لازم يكون PDF أو صورة (JPG/PNG) لحد 25 ميجا.", "The file must be a PDF or a photo (JPG/PNG) up to 25 MB."],
  duplicate_code: ["في وحدتين بنفس كود المطور في المشروع ده؛ كود المطور بيحدد الوحدة جوه المشروع.", "Two units would share a developer unit code in this project; inside a project the developer's code decides."]
};
const errorText = (r, lang) => {
  if (r.error === "duplicate") return L(lang, "الاسم ده موجود قبل كده.", "That name is already used.");
  if (r.error === "upload_failed") return L(lang, "الملف ماتحملش. جرب تاني.", "The file did not upload. Try again.");
  if (r.error === "notes_too_long" || r.error === "notes_full") return L(lang, "الملاحظات وصلت للحد (4000 حرف). اختصرها الأول، وبعدين ضيف.", "These notes are full (4,000 characters). Trim them first, then add.");
  const f = FIELD[r.field];
  return f ? f[lang === "en" ? 1 : 0] : L(lang, "في حاجة مش مظبوطة.", "Something is not right.");
};
const noticeBad = (text) => html`<p class="card notice bad" role="alert">❌ ${text}</p>`;
const noticeOk = (text) => html`<p class="card notice ok" role="status">✅ ${text}</p>`;
const label2 = (map, k, lang) => (map[k] || [k, k])[lang === "en" ? 1 : 0];
const deliveryText = (p, lang) => (p.delivery_year ? `${p.delivery_quarter ? `Q${p.delivery_quarter} ` : ""}${p.delivery_year}` : L(lang, "مش محدد", "Not stated"));
const devName = (p, lang) => (lang === "en" ? p.developer_name_en || p.developer_name_ar : p.developer_name_ar || p.developer_name_en) || "—";

function statusSelect(name, value, lang) {
  return html`<select name="${name}">${Catalogue.STATUSES.map((s) => html`<option value="${s}"${sel(value === s)}>${label2(STATUS, s, lang)}</option>`)}</select>`;
}

function developerForm(lang, d = {}, action = "/app/catalogue/developers") {
  return html`<form method="post" action="${action}" class="card stack" data-developer-form>
  <label>${L(lang, "اسم المطور *", "Developer name *")} <input name="name" required maxlength="120" value="${d.name || ""}"></label>
  <label>${L(lang, "الاسم بالإنجليزي (اختياري)", "Name in English (optional)")} <input name="name_en" maxlength="120" dir="ltr" value="${d.name_en || ""}"></label>
  <p class="muted">🔒 ${L(lang, "بيانات التواصل للمديرين بس، وعمرها ما بتظهر للعميل.", "The contact is for managers only and never shown to clients.")}</p>
  <label>${L(lang, "مسؤول المبيعات (اختياري)", "Sales contact (optional)")} <input name="contact_name" maxlength="120" value="${d.contact_name || ""}"></label>
  <label>${L(lang, "تليفونه (اختياري)", "Phone (optional)")} <input name="contact_phone" maxlength="30" dir="ltr" inputmode="tel" value="${d.contact_phone || ""}"></label>
  <fieldset><legend>${L(lang, "معلومات عامة (اختياري، كلها نص حر)", "General information (optional, free text)")}</legend>
    <label>${L(lang, "عن الشركة", "About the company")} <textarea name="about" maxlength="2000" rows="2">${d.about || ""}</textarea></label>
    <label>${L(lang, "مشروعات سابقة (سطر لكل مشروع)", "Previous projects (one per line)")} <textarea name="past_projects" maxlength="2000" rows="3">${d.past_projects || ""}</textarea></label>
    <label>${L(lang, "سجل التسليم والسمعة", "Delivery record and reputation")} <textarea name="delivery_record" maxlength="2000" rows="2">${d.delivery_record || ""}</textarea></label>
    <label>${L(lang, "أنظمة السداد المعتادة", "Usual payment terms")} <textarea name="usual_payment_terms" maxlength="2000" rows="2">${d.usual_payment_terms || ""}</textarea></label>
    <label>${L(lang, "تحذيرات للبروكرز", "Warnings for brokers")} <textarea name="warnings" maxlength="2000" rows="2">${d.warnings || ""}</textarea></label>
  </fieldset>
  <label>${L(lang, "ملاحظات داخلية للمديرين (المساعد مش بيقراها)", "Internal notes, managers only (Ask does not read them)")} <textarea name="notes" maxlength="1000" rows="2">${d.notes || ""}</textarea></label>
  <button type="submit">${d.id ? L(lang, "حفظ المطور", "Save developer") : L(lang, "إضافة المطور", "Add developer")}</button>
</form>`;
}

function planLine(pl, lang) {
  const parts = [`${L(lang, "مقدم", "Down")} ${Number(pl.down_payment_pct)}%`];
  if (Number(pl.years) > 0) parts.push(`${Number(pl.years)} ${L(lang, "سنين", "years")} · ${label2(FREQ, pl.frequency, lang)}`);
  else parts.push(L(lang, "كاش", "Cash"));
  if (Number(pl.discount_pct) > 0) parts.push(`${L(lang, "خصم", "discount")} ${Number(pl.discount_pct)}%`);
  for (const m of pl.milestones || []) parts.push(`${m.pct}% ${L(lang, `بعد ${m.due_after_months} شهر`, `after ${m.due_after_months} months`)}${m.label ? ` (${m.label})` : ""}`);
  if (pl.maintenance_pct !== null && pl.maintenance_pct !== undefined) parts.push(`${L(lang, "صيانة", "maintenance")} ${Number(pl.maintenance_pct)}%${pl.maintenance_due ? ` ${label2(DUE, pl.maintenance_due, lang)}` : ""}`);
  for (const f of pl.extra_fees || []) parts.push(`${f.label}: ${Commission.money(f.amount, lang)}`);
  return parts.join(" · ");
}

function planForm(lang, projectId, phases, pl = {}) {
  const ms = [...(pl.milestones || []), {}, {}].slice(0, 4);
  const fees = [...(pl.extra_fees || []), {}, {}].slice(0, 4);
  return html`<form method="post" action="/app/catalogue/projects/${projectId}/plans" class="card stack" data-plan-form>
  ${pl.id ? html`<input type="hidden" name="id" value="${pl.id}">` : ""}
  <p class="muted">${L(lang, "المطلوب: اسم النظام والمقدم % (عليهم *). الباقي اختياري.", "Required: plan name and down payment % (marked *). The rest is optional.")}</p>
  <label>${L(lang, "اسم النظام *", "Plan name *")} <input name="name" required maxlength="80" value="${pl.name || ""}" placeholder="${L(lang, "مثلاً: 10% مقدم على 8 سنين", "e.g. 10% down over 8 years")}"></label>
  ${phases.length ? html`<label>${L(lang, "المرحلة", "Phase")} <select name="phase_id"><option value="">${L(lang, "كل المشروع", "Whole project")}</option>${phases.map((ph) => html`<option value="${ph.id}"${sel(pl.phase_id === ph.id)}>${ph.name}</option>`)}</select></label>` : ""}
  <div class="row">
    <label>${L(lang, "المقدم % *", "Down payment % *")} <input name="down_payment_pct" required inputmode="decimal" dir="ltr" size="4" value="${val(pl.down_payment_pct)}"></label>
    <label>${L(lang, "سنين (0 = كاش)", "Years (0 = cash)")} <input name="years" inputmode="decimal" dir="ltr" size="3" value="${val(pl.years)}"></label>
    <label>${L(lang, "القسط", "Installments")} <select name="frequency">${Catalogue.FREQUENCIES.map((f) => html`<option value="${f}"${sel((pl.frequency || "quarterly") === f)}>${label2(FREQ, f, lang)}</option>`)}</select></label>
    <label>${L(lang, "خصم %", "Discount %")} <input name="discount_pct" inputmode="decimal" dir="ltr" size="4" value="${val(pl.discount_pct)}"></label>
  </div>
  <fieldset><legend>${L(lang, "دفعات إضافية (اختياري)", "Milestones (optional)")}</legend>
    ${ms.map((m) => html`<div class="row"><input name="milestone_pct" inputmode="decimal" dir="ltr" size="4" placeholder="%" value="${val(m.pct)}" aria-label="%"><input name="milestone_months" inputmode="numeric" dir="ltr" size="4" placeholder="${L(lang, "بعد كام شهر", "after months")}" value="${val(m.due_after_months)}" aria-label="${L(lang, "بعد كام شهر", "After months")}"><input name="milestone_label" maxlength="60" placeholder="${L(lang, "مثلاً: عند الاستلام", "e.g. at delivery")}" value="${m.label || ""}" aria-label="${L(lang, "الوصف", "Label")}"></div>`)}
  </fieldset>
  <div class="row">
    <label>${L(lang, "الصيانة % (سيبها فاضية لو مش معروفة)", "Maintenance % (blank when unknown)")} <input name="maintenance_pct" inputmode="decimal" dir="ltr" size="4" value="${val(pl.maintenance_pct)}"></label>
    <label>${L(lang, "تتدفع", "Due")} <select name="maintenance_due">${Catalogue.MAINTENANCE_DUE.map((d) => html`<option value="${d}"${sel((pl.maintenance_due || "delivery") === d)}>${label2(DUE, d, lang)}</option>`)}</select></label>
    <label>${L(lang, "على كام دفعة", "In how many payments")} <input name="maintenance_splits" inputmode="numeric" dir="ltr" size="2" value="${val(pl.maintenance_splits)}"></label>
  </div>
  <fieldset><legend>${L(lang, "مصاريف ثابتة (نادي، جراج...)", "Fixed extra fees (club, parking...)")}</legend>
    ${fees.map((f) => html`<div class="row"><input name="fee_label" maxlength="60" placeholder="${L(lang, "البند", "Item")}" value="${f.label || ""}" aria-label="${L(lang, "البند", "Item")}"><input name="fee_amount" inputmode="numeric" dir="ltr" size="9" placeholder="${L(lang, "المبلغ ج.م", "Amount EGP")}" value="${val(f.amount)}" aria-label="${L(lang, "المبلغ", "Amount")}"></div>`)}
  </fieldset>
  <button type="submit">${pl.id ? L(lang, "حفظ النظام", "Save plan") : L(lang, "إضافة النظام", "Add plan")}</button>
</form>`;
}

/** Plan rules (step 1): the developer's limits for this project. Every field is optional. */
function rulesForm(lang, p, base) {
  const r = p.plan_rules || {};
  const fees = [...(r.optional_fees || []), {}, {}].slice(0, 4);
  const freqs = PlanRules.FREQUENCIES;
  return html`<details class="card" id="plan-rules" data-plan-rules><summary>📏 ${L(lang, "قواعد الأنظمة (حدود المطور)", "Plan rules (developer limits)")}</summary>
  <form method="post" action="${base}/rules" class="stack">
    <p class="muted">${L(lang, "كل الخانات اختيارية. النظام اللي بره الحدود بيتعلّم عليه ومحتاج مراجعة.", "All fields are optional. A plan outside these limits is marked for review.")}</p>
    <div class="row">
      <label>${L(lang, "أقل مقدم %", "Lowest down payment %")} <input name="min_down_payment_pct" inputmode="decimal" dir="ltr" size="4" value="${val(r.min_down_payment_pct)}"></label>
      <label>${L(lang, "أطول مدة (سنين)", "Longest term (years)")} <input name="max_years" inputmode="decimal" dir="ltr" size="3" value="${val(r.max_years)}"></label>
      <label>${L(lang, "أقصى خصم %", "Highest discount %")} <input name="max_discount_pct" inputmode="decimal" dir="ltr" size="4" value="${val(r.max_discount_pct)}"></label>
    </div>
    <fieldset><legend>${L(lang, "الأقساط المسموحة", "Allowed installment frequencies")}</legend>
      ${freqs.map((f) => html`<label><input type="checkbox" name="frequencies" value="${f}"${(r.frequencies || []).includes(f) ? " checked" : ""}> ${label2(FREQ, f, lang)}</label>`)}
    </fieldset>
    <div class="row">
      <label>${L(lang, "الصيانة %", "Maintenance %")} <input name="maintenance_pct" inputmode="decimal" dir="ltr" size="4" value="${val(r.maintenance_pct)}"></label>
      <label>${L(lang, "تتدفع", "Due")} <select name="maintenance_due">${Catalogue.MAINTENANCE_DUE.map((d) => html`<option value="${d}"${sel((r.maintenance_due || "delivery") === d)}>${label2(DUE, d, lang)}</option>`)}</select></label>
    </div>
    <fieldset><legend>${L(lang, "مصاريف اختيارية (جراج، نادي...)", "Optional fees (garage, club...)")}</legend>
      ${fees.map((f) => html`<div class="row"><input name="fee_label" maxlength="60" placeholder="${L(lang, "البند", "Item")}" value="${f.label || ""}" aria-label="${L(lang, "البند", "Item")}"><input name="fee_amount" inputmode="numeric" dir="ltr" size="9" placeholder="${L(lang, "المبلغ ج.م", "Amount EGP")}" value="${val(f.amount)}" aria-label="${L(lang, "المبلغ", "Amount")}"><select name="fee_due" aria-label="${L(lang, "تتدفع", "Due")}">${Catalogue.MAINTENANCE_DUE.map((d) => html`<option value="${d}"${sel((f.due || "delivery") === d)}>${label2(DUE, d, lang)}</option>`)}</select></div>`)}
    </fieldset>
    <button type="submit">${L(lang, "حفظ القواعد", "Save rules")}</button>
  </form></details>`;
}

/** Questions about the notes Ask could not read or found conflicting (managers). Answering is optional. */
function clarifyCard(lang, base, notes) {
  const issues = Clarify.findIssues(notes);
  if (!issues.length) return "";
  return html`<section class="card" id="clarify" data-clarify><h3>❓ ${L(lang, "محتاجين توضيحك", "Please clarify")}</h3>
  <p class="muted">${L(lang, "ردك بيتحفظ في الملاحظات بتاريخه، والمساعد هيستخدمه. تقدر تتجاهل أي سؤال.", "Your answer is saved in the notes with its date and Ask will use it. You can ignore any question.")}</p>
  ${issues.map((q) => html`<form method="post" action="${base}/clarify" class="stack" data-clarify-q="${q.kind}"><p>${L(lang, q.question.ar, q.question.en)}</p>
    <input type="hidden" name="line" value="${q.line}">
    <input name="answer" maxlength="300" required aria-label="${L(lang, "الإجابة", "Answer")}"><button type="submit" class="secondary">${L(lang, "احفظ", "Save")}</button></form>`)}
</section>`;
}

function projectPage(lang, manager, data, developers, { notice = null, prices = null, commissionTerms = null, highlights = null, plansRead = null, gallery = null, photos = [], askContext = null } = {}) {
  const { project: p, developer: d, phases, plans, materials, units } = data;
  const base = `/app/catalogue/projects/${p.id}`;
  const phaseName = (id) => phases.find((x) => x.id === id)?.name;
  const facts = [
    p.price_from > 0 && [L(lang, "السعر يبدأ من", "Price from"), Commission.money(p.price_from, lang)],
    p.area_acres && [L(lang, "المساحة", "Size"), `${Number(p.area_acres)} ${L(lang, "فدان", "feddan")}`],
    p.bedroom_options?.length && [L(lang, "الغرف", "Bedrooms"), p.bedroom_options.join(" · ")],
    p.down_pct_min && [L(lang, "أقل مقدم", "Lowest down payment"), `${Number(p.down_pct_min)}%`],
    p.years_max && [L(lang, "أطول تقسيط", "Longest term"), `${Number(p.years_max)} ${L(lang, "سنين", "years")}`],
    p.discount_pct && [L(lang, "خصم", "Discount"), `${Number(p.discount_pct)}%`],
    p.delivery_raw && [L(lang, "الاستلام (زي ما اتكتب)", "Delivery (as written)"), p.delivery_raw],
    ...(data.facts || []).map((f) => [lang === "en" ? f.label_en : f.label_ar, f.value])
  ].filter(Boolean);
  const overviewTab = html`${photos.length ? carousel(photos, lang) : ""}<section class="card stack proj-head" id="details" data-project-status="${p.status}">
  <p>${label2(STATUS, p.status, lang)} · ${L(lang, "الاستلام", "Delivery")}: <span dir="ltr">${deliveryText(p, lang)}</span> · ${L(lang, "الصيانة", "Maintenance")}: ${pctText(p.maintenance_pct)}${p.archived_at ? html` · <strong>${L(lang, "مؤرشف", "Archived")}</strong>` : ""}</p>
  ${facts.length ? html`<dl class="pj-dl" data-project-facts>${facts.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : ""}
  ${(p.feature_keys || []).length ? html`<p class="row">${p.feature_keys.map((k) => html`<span class="chip chip-feature">${Features.featureLabel(k, lang)}</span>`)}</p>` : ""}
  ${[p.district, p.city].filter(Boolean).length ? html`<p>📍 ${[p.district, p.city].filter(Boolean).join("، ")}</p>` : ""}
  ${d ? html`<p>🏢 ${d.name}${manager && d?.contact_name ? ` · ${d.contact_name}` : ""}${manager && d?.contact_phone ? html` · <a href="tel:${d.contact_phone}" dir="ltr" data-developer-contact>${d.contact_phone}</a>` : ""}</p>` : ""}
  ${manager && d?.notes ? html`<p class="muted">🔒 ${d.notes} <span>(${L(lang, "ملاحظات المطور: مش بتتقرا في السؤال", "developer notes: not used by Ask")})</span></p>` : ""}
</section>
${manager ? html`<div class="row proj-actions"><a class="btn" href="${base}/edit" data-edit-project>${L(lang, "تعديل المشروع", "Edit project")}</a>
  <form method="post" action="${base}/archive" class="inline"><input type="hidden" name="archived" value="${p.archived_at ? "0" : "1"}"><button type="submit" class="secondary">${p.archived_at ? L(lang, "رجّعه من الأرشيف", "Restore") : L(lang, "أرشفة المشروع", "Archive project")}</button></form></div>` : ""}

<h2 id="assistant-knows">🤖 ${L(lang, "اللي المساعد (اسأل) عارفه", "What the assistant (Ask) knows")}</h2>
<p class="muted">${L(lang, "البروكرز بيشوفوا كل ده، والمساعد بيجاوب منه. مفيش هنا حاجة سرية: العمولة لوحدها تحت وللمديرين بس.", "Brokers see all of this and Ask answers from it. Nothing secret goes here: commission terms are kept apart below, managers only.")}</p>
${askContext ? html`<section class="card stack" id="ask-context" data-ask-context><h3>${L(lang, "اللي المساعد بيقراه عن المشروع ده", "What Ask reads about this project")}</h3>
  <ul class="ask-lines">${askContext.summary.split("\n").filter(Boolean).map((line) => html`<li>${line}</li>`)}</ul>
  <p class="muted small">${L(lang, "ده متكتب أوتوماتيك من تفاصيل المشروع (الأرقام والوحدات والمميزات والتفاصيل التانية) والملاحظات تحت. غيّر التفاصيل من «تعديل المشروع» والمساعد هيتحدّث لوحده.", "Written automatically from the project's details (numbers, units, features, other facts) and the notes below. Change the details with Edit project and Ask updates itself.")}${askContext.built_at ? ` ${L(lang, "آخر تحديث", "Updated")}: ${new Date(askContext.built_at).toISOString().slice(0, 10)}` : ""}</p></section>` : ""}
${p.notes ? html`<section class="card" id="project-notes" data-project-notes><h3>📝 ${L(lang, "ملاحظات المشروع", "Project notes")}</h3><p>${p.notes}</p></section>` : ""}
${manager ? clarifyCard(lang, base, p.notes) : ""}
${highlights ? html`<details class="proj-fold"><summary>✨ ${L(lang, "نقاط مميزة وقراءة البروشور", "Highlights and brochure")}</summary>${highlights}</details>` : ""}
${prices ? html`<details class="proj-fold" id="prices-fold"><summary>🏷️ ${L(lang, "الأسعار وزيادات الأسعار", "Prices and price increases")}</summary>${prices}</details>` : ""}

<details class="proj-fold" id="phases-fold"><summary>${L(lang, "المراحل", "Phases")}${phases.length ? ` (${phases.length})` : ""}</summary><section class="card" id="phases">
  <h2>${L(lang, "المراحل", "Phases")}</h2>
  ${phases.length ? html`<ul>${phases.map((ph) => html`<li data-phase="${ph.id}">${ph.name} · ${label2(STATUS, ph.status, lang)} · <span dir="ltr">${deliveryText(ph, lang)}</span>${manager ? html` <form method="post" action="${base}/phases/${ph.id}/delete" class="inline" data-confirm="${L(lang, `تمسح المرحلة «${ph.name}»؟ مش هينفع ترجعها.`, `Delete the phase “${ph.name}”? This can't be undone.`)}"><button type="submit" class="link danger">${L(lang, "حذف", "Delete")}</button></form>` : ""}</li>`)}</ul>` : html`<p class="muted">${L(lang, "مفيش مراحل (المشروع كله مرحلة واحدة).", "No phases (the whole project is one).")}</p>`}
  ${manager ? html`<form method="post" action="${base}/phases" class="row" data-phase-form>
    <input name="name" required maxlength="80" placeholder="${L(lang, "اسم المرحلة", "Phase name")}" aria-label="${L(lang, "اسم المرحلة", "Phase name")}">
    ${statusSelect("status", "selling", lang)}
    <input name="delivery_year" inputmode="numeric" dir="ltr" size="5" placeholder="${L(lang, "سنة الاستلام", "Delivery year")}" aria-label="${L(lang, "سنة الاستلام", "Delivery year")}">
    <input name="delivery_quarter" inputmode="numeric" dir="ltr" size="2" placeholder="Q" aria-label="${L(lang, "الربع", "Quarter")}">
    <button type="submit" class="secondary">${L(lang, "إضافة مرحلة", "Add phase")}</button></form>` : ""}
</section></details>

<p class="row"><a class="btn" href="${base}/present" data-present-link>${L(lang, "عرض للعميل", "Client presentation")}</a> <a class="btn secondary" href="${base}/calculator" data-calc-link>${L(lang, "حاسبة الأنظمة", "Payment calculator")}</a></p>
`;
  const plansTab = html`<section class="card" id="plans">
  <h2>💳 ${L(lang, "أنظمة السداد", "Payment plans")}</h2>
  <p class="muted">${L(lang, "النظام بيتطبق على كل وحدات المشروع (أو المرحلة) تلقائي، إلا الوحدة اللي ليها أنظمتها الخاصة.", "A plan applies to every unit of the project (or phase) automatically, except a unit with its own plans.")}</p>
  ${plans.length ? html`<ul>${plans.map((pl) => html`<li data-plan="${pl.id}"><strong>${pl.name}</strong>${pl.phase_id ? ` (${phaseName(pl.phase_id) || ""})` : ""}: ${planLine(pl, lang)}${manager ? html` · <a href="${base}/plans/${pl.id}">${L(lang, "تعديل", "Edit")}</a> <form method="post" action="${base}/plans/${pl.id}/delete" class="inline" data-confirm="${L(lang, `تمسح نظام السداد «${pl.name}»؟ مش هينفع ترجعه.`, `Delete the payment plan “${pl.name}”? This can't be undone.`)}"><button type="submit" class="link danger">${L(lang, "حذف", "Delete")}</button></form>` : ""}</li>`)}</ul>` : html`<p class="muted">${L(lang, "لسه مفيش أنظمة سداد.", "No payment plans yet.")}</p>`}
</section>
${manager ? rulesForm(lang, p, base) : ""}
${manager ? html`<details class="card"><summary>➕ ${L(lang, "نظام سداد جديد", "New payment plan")}</summary>${planForm(lang, p.id, phases)}</details>` : ""}
${plansRead || ""}

`;
  const filesTab = html`<h2 id="client-files">📤 ${L(lang, "ملفات ولينكات للعملاء", "Files and links for clients")}</h2>
<p class="muted">${L(lang, "اللي بيتبعت للعميل لينك. المساعد مش بيقرا الملفات دي: اللي بيقراه بيتحط فوق (البروشور وقايمة الأسعار وأنظمة السداد). العميل بياخد بس اللي عليه \"يظهر للعميل\".", "What is sent to clients as links. Ask does not read these files: what it reads is added above (brochure, price list, payment plans). A client gets only the ones marked \"Show to clients\".")}</p>
${gallery || ""}
<section class="card" id="materials">
  <h3>📁 ${L(lang, "الملفات واللينكات", "Materials")}</h3>
  ${materials.length ? html`<ul>${materials.map((m) => html`<li data-material="${m.id}" data-client-visible="${m.client_visible ? "1" : "0"}">
    <a href="${m.url}" target="_blank" rel="noopener noreferrer">${m.storage_path ? "📎 " : ""}${m.label}</a> · ${label2(KIND, m.kind, lang)}${m.unit_type ? ` · ${m.unit_type}` : ""} · ${m.client_visible ? L(lang, "👁️ بيظهر للعميل", "👁️ Client-visible") : L(lang, "🔒 داخلي", "🔒 Internal")}${m.check_status === "broken" ? html` · <strong data-broken>⚠️ ${L(lang, "مبقاش بيفتح", "Not opening")}</strong>` : ""}
    ${manager ? html`${m.kind === "price_sheet" ? "" : html`<form method="post" action="${base}/materials/${m.id}/visibility" class="inline"><input type="hidden" name="visible" value="${m.client_visible ? "0" : "1"}"><button type="submit" class="link">${m.client_visible ? L(lang, "خليه داخلي", "Make internal") : L(lang, "اعرضه للعميل", "Show to clients")}</button></form>`}
    <form method="post" action="${base}/materials/${m.id}/delete" class="inline" data-confirm="${L(lang, `تمسح «${m.label}»؟ مش هينفع ترجعه.`, `Delete “${m.label}”? This can't be undone.`)}"><button type="submit" class="link danger">${L(lang, "حذف", "Delete")}</button></form>` : ""}</li>`)}</ul>` : html`<p class="muted">${L(lang, "لسه مفيش ملفات أو لينكات.", "No files or links yet.")}</p>`}
  ${manager ? html`<form method="post" action="${base}/materials" class="stack" data-material-form>
    <div class="row">
      <input name="label" required maxlength="80" placeholder="${L(lang, "الاسم (مثلاً: بروشور المرحلة 2)", "Label (e.g. Phase 2 brochure)")}" aria-label="${L(lang, "الاسم", "Label")}">
      <select name="kind" aria-label="${L(lang, "النوع", "Type")}">${Catalogue.KINDS.map((k) => html`<option value="${k}">${label2(KIND, k, lang)}</option>`)}</select>
    </div>
    <input name="url" required type="url" dir="ltr" placeholder="https://" aria-label="${L(lang, "اللينك", "Link")}">
    <input name="unit_type" maxlength="60" placeholder="${L(lang, "نوع الوحدة (للمخطط، اختياري)", "Unit type (for a layout, optional)")}" aria-label="${L(lang, "نوع الوحدة", "Unit type")}">
    <label><input type="checkbox" name="client_visible" value="1"> ${L(lang, "يظهر للعميل", "Show to clients")}</label>
    <button type="submit" class="secondary">${L(lang, "إضافة لينك", "Add link")}</button>
    <p class="muted">${L(lang, "بنتأكد مرة في الأسبوع إن كل لينك لسه بيفتح ونبلغ المديرين لو واحد وقف.", "Once a week every link is checked and managers hear about broken ones.")}</p>
  </form>` : ""}
  ${manager ? html`<form method="post" action="${base}/materials/upload" enctype="multipart/form-data" class="stack" data-material-upload>
    <h3>📎 ${L(lang, "حمل ملف", "Upload a file")}</h3>
    <input type="file" name="file" required accept="application/pdf,image/jpeg,image/png,image/webp" aria-label="${L(lang, "الملف", "File")}">
    <div class="row">
      <input name="label" maxlength="80" placeholder="${L(lang, "الاسم (اختياري، اسم الملف لو فاضي)", "Label (optional, file name when empty)")}" aria-label="${L(lang, "الاسم", "Label")}">
      <select name="kind" aria-label="${L(lang, "النوع", "Type")}">${Catalogue.KINDS.filter((k) => k !== "price_sheet").map((k) => html`<option value="${k}"${sel(k === "brochure")}>${label2(KIND, k, lang)}</option>`)}</select>
    </div>
    <input name="unit_type" maxlength="60" placeholder="${L(lang, "نوع الوحدة (للمخطط، اختياري)", "Unit type (for a layout, optional)")}" aria-label="${L(lang, "نوع الوحدة", "Unit type")}">
    <label><input type="checkbox" name="client_visible" value="1"> ${L(lang, "يظهر للعميل", "Show to clients")}</label>
    <button type="submit" class="secondary">${L(lang, "تحميل", "Upload")}</button>
  </form>` : ""}
</section>
${commissionTerms ? html`<h2 id="commission-area">🔐 ${L(lang, "العمولة (للمديرين بس)", "Commission (managers only)")}</h2>
<p class="muted">${L(lang, "سري: مش بيظهر للبروكرز ولا للعملاء ولا للمساعد.", "Secret: never shown to brokers, clients or Ask.")}</p>${commissionTerms}` : ""}

`;
  const unitsTab = html`<section class="card" id="units">
  <h2>🏠 ${L(lang, "وحدات المشروع", "Project units")} (${units.length})</h2>
  ${units.length ? html`<ul>${units.map((u) => html`<li data-unit="${u.code}"><a href="/app/units/${encodeURIComponent(u.code)}">${u.code}</a>${u.developer_unit_code ? ` · ${u.developer_unit_code}` : ""}${u.phase_id ? ` · ${phaseName(u.phase_id) || ""}` : ""} · ${u.status}${manager ? html` <form method="post" action="${base}/units/${u.id}/unlink" class="inline" data-confirm="${L(lang, `تشيل الوحدة ${u.code} من المشروع؟`, `Remove unit ${u.code} from the project?`)}"><button type="submit" class="link">${L(lang, "شيلها من المشروع", "Remove from project")}</button></form>` : ""}</li>`)}</ul>` : html`<p class="muted">${L(lang, "لسه مفيش وحدات مربوطة بالمشروع.", "No units linked yet.")}</p>`}
  ${manager ? html`<form method="post" action="${base}/units" class="stack" data-link-units>
    <label>${L(lang, "اربط وحدات بأكوادها (مسافة أو فاصلة بينهم)", "Link units by code (space or comma between)")} <input name="codes" required dir="ltr"></label>
    ${phases.length ? html`<label>${L(lang, "المرحلة", "Phase")} <select name="phase_id"><option value="">—</option>${phases.map((ph) => html`<option value="${ph.id}">${ph.name}</option>`)}</select></label>` : ""}
    <button type="submit" class="secondary">${L(lang, "ربط", "Link")}</button></form>` : ""}
</section>`;
  const phaseTabs = [
    [L(lang, "نظرة عامة", "Overview"), overviewTab],
    [L(lang, "أنظمة السداد", "Payment plans"), plansTab],
    [L(lang, "ملفات للعملاء", "Client files"), filesTab],
    [L(lang, "الوحدات", "Units"), unitsTab]
  ];
return html`<p><a class="btn secondary small" href="/app/catalogue">‹ ${L(lang, "الكتالوج", "Catalogue")}</a></p>
<h1>🏗️ ${lang === "en" ? p.name_en || p.name : p.name}</h1>
${notice || ""}
${tabs("proj-tabs", phaseTabs)}`;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const nameIn = (r, lang) => (r ? (lang === "en" ? r.name_en || r.name_ar : r.name_ar || r.name_en) : "");
/** A new-project form posts paste_text always; the place is required there (the service itself only needs a name). */
const needsPlace = (b) => b.paste_text !== undefined && !String(b.area_id || "").trim() && !String(b.compound || "").trim();

function register(web, { pool, page, assets }) {
  const forbidden = (req, res) => res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));
  const notFound = (req, res) => res.status(404).type("text/plain").send(L(langOf(req), "مش موجود", "Not found"));
  const title = (lang) => L(lang, "كتالوج المطورين", "Developer catalogue");
  const SAVED = { 1: ["اتحفظ.", "Saved."], linked: ["الوحدات اتربطت.", "Units linked."], material_bad: ["المشروع اتحفظ، بس الملف أو اللينك ماتضافش. ضيفه من الملفات تحت.", "The project was saved, but the file or link was not added. Add it under Materials below."] };
  const savedNotice = (req) => {
    const s = SAVED[req.query.saved];
    if (!s) return null;
    const lang = langOf(req);
    const missing = String(req.query.missing || "").trim();
    return html`${noticeOk(s[lang === "en" ? 1 : 0])}${missing ? noticeBad(`${L(lang, "الأكواد دي مش موجودة", "These codes were not found")}: ${missing}`) : ""}`;
  };

  const showList = async (req, res, notice = null, status = 200) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const archived = req.query.archived === "1";
    const q = req.query;
    const state = {
      pq: String(q.pq || "").slice(0, 80),
      pl: UUID.test(q.pl) ? q.pl : "",
      f: [].concat(q.f || []).filter((k) => Features.isFeatureKey(k)),
      dev: UUID.test(q.dev) ? q.dev : "",
      bed: /^[1-9]$/.test(q.bed) ? q.bed : "",
      max: String(q.max || "").slice(0, 15),
      archived
    };
    const [projPage, devPage, dev, lists] = await Promise.all([
      ProjectSearch.browse(pool, actor, { q: state.pq, page: q.pp, archived, place: state.pl, features: state.f, developer: state.dev, bedrooms: state.bed, maxPrice: state.max }),
      Catalogue.listDevelopersPage(pool, actor, { page: q.dp }),
      state.dev ? Catalogue.getDeveloper(pool, actor, state.dev) : null,
      state.pl ? Suggest.lists(pool) : null
    ]);
    const placeRow = lists && (lists.places.find((x) => x.id === state.pl) || lists.areas.find((x) => x.id === state.pl));
    const labels = { place: nameIn(placeRow, lang), developer: dev ? dev.name : "" };
    const manager = isManager(actor);
    const body = html`${listPage(lang, { projects: projPage.projects, projPage, devPage, state, labels, notice: notice || savedNotice(req), manager, developerForm: manager ? developerForm(lang) : "" })}<script src="${assets.url("catalogueSearch.js")}" defer></script>`;
    return page(req, res, { title: title(lang), nav: "catalogue", body }, status);
  };

  // The add/edit project form: the unit box for the place and features, a message reader, the developer list. Shown for a GET (a new
  // project, or one to edit) and again, with what was typed, after a refused save.
  const showForm = async (req, res, { project = null, notice = null, status = 200 } = {}) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const l = await Suggest.lists(pool);
    const b = req.method === "POST" ? req.body : null;
    const placeRow = project && l.places.find((x) => x.id === project.place_id);
    const v = b
      ? { ...b, bedroom_options: [].concat(b.bedrooms || []).map(Number), property_types: [].concat(b.property_types || []), feature_keys: [].concat(b.feature || []), features_other: String(b.features_other || "").split(/[,،]/).map((x) => x.trim()).filter(Boolean) }
      : { ...project, compound: nameIn(placeRow, lang) };
    const place = await Suggest.placeChip(pool, { compound: v.compound, area_id: v.area_id, subzone_id: v.subzone_id }, lang);
    const dev = b
      ? (UUID.test(b.developer_id) ? { id: b.developer_id, name: (await Catalogue.getDeveloper(pool, actor, b.developer_id))?.name || b.developer_name } : b.developer_name || b.developer_global_id ? { name: b.developer_name || (await pool.query("SELECT name FROM global_developers WHERE id::text = $1", [b.developer_global_id])).rows[0]?.name || "", global_id: b.developer_global_id || undefined } : null)
      : project && project.developer_id ? { id: project.developer_id, name: project.developer_name } : null;
    const edit = Boolean(project);
    const base = edit ? `/app/catalogue/projects/${project.id}` : "/app/catalogue";
    const form = projectForm({ values: v, mode: edit ? "edit" : "new", action: edit ? base : "/app/catalogue/projects", lang, areas: l.areas, place, developer: dev, error: notice, cancelHref: base, sourceText: v.paste_text ?? (project ? project.source_text || "" : "") });
    const body = html`<p><a class="btn secondary small" href="${base}">‹ ${edit ? project.name : L(lang, "الكتالوج", "Catalogue")}</a></p><div class="uf-top"><h1>${edit ? L(lang, "تعديل المشروع", "Edit project") : L(lang, "مشروع جديد", "New project")}</h1></div>${form}<script src="${assets.url("unitBox.js")}"></script><script src="${assets.url("projectForm.js")}"></script>`;
    return page(req, res, { title: edit ? project.name : L(lang, "مشروع جديد", "New project"), nav: "catalogue", body }, status);
  };
  const showNew = (req, res, notice = null, status = 200) => showForm(req, res, { notice, status });
  const showEdit = async (req, res, notice = null, status = 200) => {
    const data = await Catalogue.getProject(pool, req.session.broker, req.params.id);
    return data ? showForm(req, res, { project: data.project, notice, status }) : notFound(req, res);
  };

  const showProject = async (req, res, notice = null, status = 200) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const data = await Catalogue.getProject(pool, actor, req.params.id);
    if (!data) return notFound(req, res);
    const manager = isManager(actor);
    const [developers, sheets, increases] = await Promise.all([
      manager ? Catalogue.listDevelopers(pool, actor) : [],
      manager ? PriceSheets.listSheets(pool, actor, data.project.id) : [],
      PriceSheets.listIncreases(pool, actor, data.project.id)
    ]);
    const reading = manager ? await PriceReading.usage(pool, actor.agency_id) : null;
    const prices = pricesSection(lang, manager, { project: data.project, units: data.units, sheets, increases, phases: data.phases, reading });
    // C8: the developer's commission terms (managers only).
    const commissionTerms = manager ? termsSection(lang, data.project.id, await Commissions.getTerms(pool, actor, data.project.id)) : null;
    // C6: highlights (everyone) with the brochure reader (managers).
    const highlights = highlightsSection(lang, manager, data.project, { reading, query: req.query });
    const plansRead = manager ? plansReadSection(lang, data.project, reading, req.query) : null;
    // F23: the project's photo gallery.
    const galleryData = await Gallery.list(pool, actor, data.project.id);
    const gallery = gallerySection(lang, manager, galleryData, { reading, query: req.query });
    const photos = (galleryData?.images || []).filter((i) => i.role === "shared" && String(i.mime || "").startsWith("image/")).map((i) => Storage.photoUrl(i.url));
    // What Ask reads about this project (the stored context: details, offers, facts, notes), shown as it is.
    const askContext = await require("../../services/projectContext").contextFor(pool, actor.agency_id, data.project.id).catch(() => null);
    return page(req, res, { title: data.project.name, nav: "catalogue", body: html`<div class="proj-page">${projectPage(lang, manager, data, developers, { notice: notice || pricesNotice(req.query, lang) || savedNotice(req), prices, commissionTerms, highlights, plansRead, gallery, photos, askContext })}</div>` }, status);
  };

  /** Runs a service write and answers: 403, 404, the page again with the error (400), or a redirect. */
  const write = (fn, { show, done }) => async (req, res) => {
    const r = await fn(req);
    if (r.error === "forbidden") return forbidden(req, res);
    if (r.error === "not_found") return notFound(req, res);
    if (r.error) return show(req, res, noticeBad(errorText(r, langOf(req))), 400);
    return res.redirect(303, done(req, r));
  };
  const projectUrl = (req, extra = "saved=1") => `/app/catalogue/projects/${req.params.id}?${extra}`;
  const actorOf = (req) => req.session.broker;

  web.get("/catalogue", (req, res) => showList(req, res));
  // JSON for the page's scripts: the search box (places, features, developers, projects) and the form's developer list.
  web.get("/catalogue/search-box", async (req, res) => {
    res.set("Cache-Control", "no-store");
    return res.json({ items: await ProjectPaste.searchBox(pool, actorOf(req), req.query.q, langOf(req)) });
  });
  web.get("/catalogue/developers/suggest", async (req, res) => {
    if (!isManager(actorOf(req))) return forbidden(req, res);
    res.set("Cache-Control", "no-store");
    return res.json({ items: await ProjectPaste.developerBox(pool, actorOf(req), req.query.q) });
  });
  // A pasted launch message → what the form shows (free, no AI, nothing saved).
  web.post("/catalogue/projects/read", async (req, res) => {
    if (!isManager(actorOf(req))) return forbidden(req, res);
    res.set("Cache-Control", "no-store");
    return res.json(await ProjectPaste.read(pool, actorOf(req), String((req.body || {}).text || ""), langOf(req)));
  });
  web.get("/catalogue/projects/new", (req, res) => showForm(req, res));
  web.get("/catalogue/projects/:id/edit", (req, res) => showEdit(req, res));
  web.post("/catalogue/developers", write((req) => Catalogue.saveDeveloper(pool, actorOf(req), req.body), { show: showList, done: () => "/app/catalogue?saved=1" }));
  // A new project may come with photos (the carousel), a brochure file and/or a link for its materials.
  web.post("/catalogue/projects", uploadNew, write(async (req) => {
    const actor = actorOf(req);
    if (needsPlace(req.body)) return { error: "invalid", field: "place" };
    const r = await Catalogue.saveProject(pool, actor, req.body);
    if (r.error) return r;
    const visible = req.body.material_client_visible;
    const file = req.files?.file?.[0];
    const fileR = file ? await Catalogue.uploadMaterial(pool, actor, r.project.id, file, { client_visible: visible }) : { ok: true };
    const linkR = String(req.body.material_url || "").trim()
      ? await Catalogue.saveMaterial(pool, actor, r.project.id, { label: L(langOf(req), "لينك", "Link"), kind: "other", url: req.body.material_url, client_visible: visible })
      : { ok: true };
    const photos = req.files?.doc || [];
    const photoR = photos.length ? await Gallery.upload(pool, actor, r.project.id, { files: photos }) : { ok: true };
    return { ...r, materialFailed: Boolean(fileR.error || linkR.error || photoR.error) };
  }, { show: showNew, done: (_req, r) => `/app/catalogue/projects/${r.project.id}?saved=${r.materialFailed ? "material_bad" : "1"}` }));

  const showDeveloper = async (req, res, notice = null, status = 200) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const d = await Catalogue.getDeveloper(pool, actor, req.params.id);
    if (!d) return notFound(req, res);
    const projects = await Catalogue.listProjects(pool, actor, { developerId: d.id });
    return page(req, res, {
      title: d.name,
      body: html`<p><a class="btn secondary small" href="/app/catalogue">‹ ${L(lang, "الكتالوج", "Catalogue")}</a></p><h1>🏢 ${d.name}</h1>${notice || savedNotice(req) || ""}
${developerForm(lang, d, `/app/catalogue/developers/${d.id}`)}
<section class="card"><h2>${L(lang, "مشاريعه", "Projects")}</h2>${projects.length ? html`<ul>${projects.map((p) => html`<li><a href="/app/catalogue/projects/${p.id}">${p.name}</a></li>`)}</ul>` : html`<p class="muted">—</p>`}</section>`
    }, status);
  };
  web.get("/catalogue/developers/:id", (req, res) => showDeveloper(req, res));
  web.post("/catalogue/developers/:id", write((req) => Catalogue.saveDeveloper(pool, actorOf(req), { ...req.body, id: req.params.id }), { show: showDeveloper, done: (req) => `/app/catalogue/developers/${req.params.id}?saved=1` }));

  // Step 6: the payment schedule of the calculator's plan as an Excel file (same inputs as the calculator page).
  web.get("/catalogue/projects/:id/calculator.xlsx", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const data = await Catalogue.getProject(pool, actor, req.params.id);
    if (!data) return notFound(req, res);
    const rules = data.project.plan_rules || {};
    const unit = data.units.find((u) => u.code === req.query.unit) || null;
    if (!unit || !(Number(unit.price_value) > 0)) return res.status(404).send("no priced unit");
    const frequency = PlanRules.FREQUENCIES.includes(req.query.freq) ? req.query.freq : "quarterly";
    const down = Math.min(100, Math.max(0, Number(req.query.down ?? 10) || 0));
    const years = Math.min(20, Math.max(0, Number(req.query.years ?? 8) || 0));
    const plan = { down_payment_pct: down, years, frequency, discount_pct: 0, maintenance_pct: rules.maintenance_pct, maintenance_due: rules.maintenance_due };
    const out = F.generateDetailedSchedule(Number(unit.price_value), plan, new Date());
    const ExcelJS = require("exceljs");
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(lang === "en" ? "Schedule" : "الجدول");
    ws.views = [{ rightToLeft: lang !== "en" }];
    ws.addRow([lang === "en" ? "Unit" : "الوحدة", unit.code, lang === "en" ? "Project" : "المشروع", data.project.name]);
    ws.addRow([lang === "en" ? "Price" : "السعر", Math.round(Number(unit.price_value)), lang === "en" ? "Down payment %" : "المقدم %", down, lang === "en" ? "Years" : "السنين", years]);
    ws.addRow([]);
    ws.addRow([lang === "en" ? "No." : "م", lang === "en" ? "Due date" : "التاريخ", lang === "en" ? "Type" : "النوع", lang === "en" ? "Amount" : "المبلغ", lang === "en" ? "Maintenance" : "الصيانة", lang === "en" ? "Total" : "الإجمالي"]);
    for (const r of out.rows) {
      ws.addRow([r.period, r.due_date ? new Date(r.due_date) : "", r.type, Math.round(r.amount || 0), Math.round(r.maintenance_amount || 0), Math.round(r.total_outflow || 0)]);
    }
    ws.getColumn(2).numFmt = "dd/mm/yyyy";
    const buf = await wb.xlsx.writeBuffer();
    return res.set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="schedule-${unit.code}.xlsx"` }).send(Buffer.from(buf));
  });

  // Step 3: the project presentation a broker shows a client (phone first). Only client-visible files, approved plans
  // and the unit types with a price. Developer contact and internal notes never appear here.
  web.get("/catalogue/projects/:id/present", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const data = await Catalogue.getProject(pool, actor, req.params.id);
    if (!data) return notFound(req, res);
    const p = data.project;
    const money = (n) => Math.round(Number(n) || 0).toLocaleString(lang === "en" ? "en-US" : "ar-EG") + (lang === "en" ? " EGP" : " ج.م");
    const types = new Map();
    for (const u of data.units.filter((x) => Number(x.price_value) > 0)) {
      const key = `${u.property_type || "other"}|${u.bedrooms ?? ""}`;
      const t = types.get(key) || { type: u.property_type || "other", bedrooms: u.bedrooms, count: 0, from: Infinity, areaMin: Infinity, areaMax: 0 };
      t.count += 1;
      t.from = Math.min(t.from, Number(u.price_value));
      if (Number(u.area_value) > 0) { t.areaMin = Math.min(t.areaMin, Number(u.area_value)); t.areaMax = Math.max(t.areaMax, Number(u.area_value)); }
      types.set(key, t);
    }
    const unitTypes = [...types.values()].sort((a, b) => a.from - b.from);
    // Features only appear when some available unit has them (the data decides the filters).
    const featureChips = [...new Set(data.units.flatMap((u) => u.feature_keys || []))].map((k) => require("../../domain/features").featureLabel(k, lang));
    const plans = data.plans.filter((pl) => pl.exception_status !== "needs_approval");
    const files = data.materials.filter((m) => m.client_visible && m.kind !== "price_sheet" && m.check_status !== "broken");
    const delivery = p.delivery_year ? `${p.delivery_quarter ? `Q${p.delivery_quarter} ` : ""}${p.delivery_year}` : null;
    const body = html`<section class="card stack" id="presentation" data-presentation>
  <h1>${lang === "en" ? p.name_en || p.name : p.name}</h1>
  <p class="muted">${data.developer?.name || ""}${delivery ? ` · ${L(lang, "التسليم", "Delivery")} ${delivery}` : ""}</p>
  ${featureChips.length ? html`<p class="row">${featureChips.map((c) => html`<span class="chip">${c}</span>`)}</p>` : ""}
  ${unitTypes.length ? html`<div class="stack"><h2>${L(lang, "الوحدات المتاحة", "Available units")}</h2>
    ${unitTypes.map((t) => html`<div class="card"><strong>${t.type}${t.bedrooms ? ` · ${t.bedrooms} ${L(lang, "غرف", "bed")}` : ""}</strong>
      <p>${L(lang, "من", "From")} ${money(t.from)} · ${t.count} ${L(lang, "وحدة", "units")}${t.areaMax ? ` · ${Math.round(t.areaMin)}–${Math.round(t.areaMax)} m²` : ""}</p></div>`)}
  </div>` : ""}
  ${plans.length ? html`<div class="stack"><h2>${L(lang, "أنظمة السداد", "Payment plans")}</h2>
    ${plans.map((pl) => html`<div class="card"><strong>${pl.name}</strong><p>${L(lang, "المقدم", "Down payment")} ${Number(pl.down_payment_pct)}%${Number(pl.years) ? ` · ${Number(pl.years)} ${L(lang, "سنين", "years")}` : ""} · ${label2(FREQ, pl.frequency, lang)}</p></div>`)}
  </div>` : ""}
  ${files.length ? html`<div class="stack"><h2>${L(lang, "ملفات ولينكات", "Files and links")}</h2>
    <ul>${files.map((m) => html`<li><a href="${m.url}" target="_blank" rel="noopener noreferrer">${m.label}</a> · ${label2(KIND, m.kind, lang)}</li>`)}</ul></div>` : ""}
  <p><a class="btn" href="/app/catalogue/projects/${p.id}/calculator">${L(lang, "احسب نظام سداد", "Calculate a payment plan")}</a></p>
  <p><a class="btn secondary small" href="/app/catalogue/projects/${p.id}">${L(lang, "رجوع للمشروع", "Back to project")}</a></p>
</section>`;
    return page(req, res, { title: `${lang === "en" ? p.name_en || p.name : p.name} · ${L(lang, "عرض", "Presentation")}`, nav: "catalogue", body });
  });

  // Step 2: the payment calculator for one project unit. Inputs are GET fields so the page works without script; a
  // static script submits it on each change. Rule checks come from the project's plan rules.
  web.get("/catalogue/projects/:id/calculator", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    const data = await Catalogue.getProject(pool, actor, req.params.id);
    if (!data) return notFound(req, res);
    const rules = data.project.plan_rules || {};
    const units = data.units.filter((u) => Number(u.price_value) > 0);
    const unit = units.find((u) => u.code === req.query.unit) || units[0] || null;
    const frequency = PlanRules.FREQUENCIES.includes(req.query.freq) ? req.query.freq : "quarterly";
    const down = Math.min(100, Math.max(0, Number(req.query.down ?? 10) || 0));
    const years = Math.min(20, Math.max(0, Number(req.query.years ?? 8) || 0));
    // Fees show only when some available unit in the project has the feature they stand for (the data decides).
    const unitKeys = new Set(units.flatMap((u) => u.feature_keys || []));
    const fees = PlanRules.visibleFees((rules.optional_fees || []).map((f, i) => ({ ...f, i, on: req.query[`fee${i}`] === "1" })), unitKeys);
    const verdict = PlanRules.checkPlan(rules, { down_payment_pct: down, years, frequency, discount_pct: 0 });
    const price = unit ? Math.round(Number(unit.price_value)) : 0;
    const summary = price ? F.calculatePlanSummary(price, { down_payment_pct: down, years, frequency, discount_pct: 0, maintenance_pct: rules.maintenance_pct, maintenance_due: rules.maintenance_due }) : null;
    const extra = fees.filter((f) => f.on).reduce((sum, f) => sum + f.amount, 0);
    // The same numbers as JSON, for the page to update in place when an input changes.
    if (req.query.format === "json") {
      return res.json({
        price,
        down_payment: summary ? Math.round(summary.down_payment) : 0,
        installment: summary ? Math.round(summary.installment_amount) : 0,
        installments: summary ? summary.total_installments_count : 0,
        extra,
        exception: verdict.exception,
        reasons: verdict.reasons
      });
    }
    const money = (n) => Math.round(Number(n) || 0).toLocaleString(lang === "en" ? "en-US" : "ar-EG") + (lang === "en" ? " EGP" : " ج.م");
    const body = html`<section class="card stack" id="calculator" data-calculator>
  <h1>🧮 ${L(lang, "حاسبة الأنظمة", "Payment calculator")} · ${data.project.name}</h1>
  <form method="get" action="/app/catalogue/projects/${data.project.id}/calculator" class="stack" data-calc>
    <label>${L(lang, "الوحدة", "Unit")} <select name="unit">${units.map((u) => html`<option value="${u.code}"${u.code === (unit && unit.code) ? " selected" : ""}>${u.code} · ${money(u.price_value)}</option>`)}</select></label>
    <div class="row">
      <label>${L(lang, "المقدم %", "Down payment %")} <input name="down" type="number" min="0" max="100" step="0.5" value="${down}" dir="ltr"></label>
      <label>${L(lang, "السنين", "Years")} <input name="years" type="number" min="0" max="20" step="0.5" value="${years}" dir="ltr"></label>
      <label>${L(lang, "القسط", "Installments")} <select name="freq">${PlanRules.FREQUENCIES.map((f) => html`<option value="${f}"${f === frequency ? " selected" : ""}>${f}</option>`)}</select></label>
    </div>
    ${fees.length ? html`<fieldset><legend>${L(lang, "مصاريف اختيارية", "Optional fees")}</legend>${fees.map((f) => html`<label><input type="checkbox" name="fee${f.i}" value="1"${f.on ? " checked" : ""}> ${f.label}: ${money(f.amount)}</label>`)}</fieldset>` : ""}
    <noscript><button type="submit">${L(lang, "احسب", "Calculate")}</button></noscript>
  </form>
  ${summary ? html`<p><a class="btn secondary small" href="/app/catalogue/projects/${data.project.id}/calculator.xlsx?unit=${encodeURIComponent(unit.code)}&down=${down}&years=${years}&freq=${frequency}" data-excel-link>${L(lang, "حمّل الجدول (إكسيل)", "Download schedule (Excel)")}</a></p>` : ""}
  ${summary ? html`<div class="stack">
    <p><strong>${L(lang, "سعر الوحدة", "Unit price")}:</strong> ${money(price)}</p>
    <p><strong>${L(lang, "المقدم", "Down payment")}:</strong> <span data-out="down_payment">${money(summary.down_payment)}</span></p>
    <p><strong>${L(lang, "القسط", "Installment")}:</strong> <span data-out="installment">${money(summary.installment_amount)}</span> × <span data-out="installments">${summary.total_installments_count}</span></p>
    ${extra ? html`<p><strong>${L(lang, "مصاريف اختيارية", "Optional fees")}:</strong> <span data-out="extra">${money(extra)}</span></p>` : ""}
    ${verdict.exception ? html`<p class="notice" role="status" data-out="warning">⚠️ ${L(lang, "النظام ده برا حدود المطور. محتاج مراجعة مدير.", "This plan is outside the developer's limits and needs a manager's review.")}</p>` : html`<p class="muted">${L(lang, "النظام داخل حدود المطور.", "Within the developer's limits.")}</p>`}
  </div>` : html`<p class="muted">${L(lang, "مفيش وحدات بسعر في المشروع.", "No priced units in this project.")}</p>`}
  <p><a class="btn secondary small" href="/app/catalogue/projects/${data.project.id}">${L(lang, "رجوع للمشروع", "Back to project")}</a></p>
  <script src="/app/static/calculator.js" defer></script>
</section>`;
    return page(req, res, { title: `${L(lang, "حاسبة", "Calculator")} · ${data.project.name}`, nav: "catalogue", body });
  });
  web.get("/catalogue/projects/:id", (req, res) => showProject(req, res));
  web.post("/catalogue/projects/:id", write((req) => (needsPlace(req.body) ? { error: "invalid", field: "place" } : Catalogue.saveProject(pool, actorOf(req), { ...req.body, id: req.params.id })), { show: showEdit, done: (req) => projectUrl(req) }));
  web.post("/catalogue/projects/:id/clarify", write((req) => Catalogue.addClarification(pool, actorOf(req), req.params.id, req.body), { show: showProject, done: (req) => `${projectUrl(req)}#clarify` }));
  web.post("/catalogue/projects/:id/archive", write((req) => Catalogue.archiveProject(pool, actorOf(req), req.params.id, req.body.archived === "1"), { show: showProject, done: (req) => projectUrl(req) }));
  web.post("/catalogue/projects/:id/phases", write((req) => Catalogue.savePhase(pool, actorOf(req), req.params.id, req.body), { show: showProject, done: (req) => `${projectUrl(req)}#phases` }));
  web.post("/catalogue/projects/:id/phases/:phaseId/delete", write((req) => Catalogue.deletePhase(pool, actorOf(req), req.params.id, req.params.phaseId), { show: showProject, done: (req) => `${projectUrl(req)}#phases` }));
  web.post("/catalogue/projects/:id/plans", write((req) => Catalogue.savePlan(pool, actorOf(req), req.params.id, req.body), { show: showProject, done: (req) => `${projectUrl(req)}#plans` }));
  web.post("/catalogue/projects/:id/plans/read", uploadPlansDoc, async (req, res) => {
    const lang = langOf(req);
    const broker = actorOf(req);
    if (!isManager(broker)) return forbidden(req, res);
    const gate = await RateLimit.hit(pool, `upload:broker:${broker.id}`, RateLimit.LIMITS.uploadBroker);
    if (!gate.allowed) return res.status(429).type("text/plain").send(L(lang, "حملت ملفات كتير. استنى شوية.", "Too many uploads. Wait a moment."));
    const r = await PlanReading.read(pool, broker, req.params.id, { files: req.files?.doc || [], pages: req.body.pages });
    if (r.error === "not_found") return notFound(req, res);
    if (r.error) return res.redirect(303, `/app/catalogue/projects/${req.params.id}?plans_error=${encodeURIComponent(r.error)}${r.error === "ALLOWANCE" ? `&left=${r.left}&needed=${r.needed}` : ""}#plans-read`);
    return res.redirect(303, `/app/catalogue/projects/${req.params.id}#plans-read`);
  });
  web.post("/catalogue/projects/:id/plans/draft/apply", async (req, res) => {
    const r = await PlanReading.apply(pool, actorOf(req), req.params.id, req.body);
    if (r.error === "forbidden") return forbidden(req, res);
    if (r.error === "not_found") return notFound(req, res);
    if (r.error) return res.redirect(303, `/app/catalogue/projects/${req.params.id}?plans_error=${r.error}#plans-read`);
    const failed = r.failed.length ? `&plans_failed=${encodeURIComponent(r.failed.join(", "))}` : "";
    return res.redirect(303, `/app/catalogue/projects/${req.params.id}?plans_saved=${r.saved}${failed}#plans`);
  });
  web.post("/catalogue/projects/:id/plans/draft/discard", write((req) => PlanReading.discard(pool, actorOf(req), req.params.id), { show: showProject, done: (req) => `/app/catalogue/projects/${req.params.id}#plans` }));
  web.post("/catalogue/projects/:id/rules", write((req) => PlanRules.saveRules(pool, actorOf(req), req.params.id, req.body), { show: showProject, done: (req) => `${projectUrl(req)}#plans` }));
  web.post("/catalogue/projects/:id/plans/:planId/delete", write((req) => Catalogue.deletePlan(pool, actorOf(req), req.params.id, req.params.planId), { show: showProject, done: (req) => `${projectUrl(req)}#plans` }));
  web.get("/catalogue/projects/:id/plans/:planId", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!isManager(actor)) return forbidden(req, res);
    const data = await Catalogue.getProject(pool, actor, req.params.id);
    const plan = data?.plans.find((pl) => pl.id === req.params.planId);
    if (!plan) return notFound(req, res);
    return page(req, res, {
      title: plan.name,
      body: html`<p><a class="btn secondary small" href="/app/catalogue/projects/${data.project.id}#plans">‹ ${data.project.name}</a></p><h1>💳 ${plan.name}</h1>${planForm(lang, data.project.id, data.phases, plan)}`
    });
  });
  web.post("/catalogue/projects/:id/materials", write((req) => Catalogue.saveMaterial(pool, actorOf(req), req.params.id, req.body), { show: showProject, done: (req) => `${projectUrl(req)}#materials` }));
  web.post("/catalogue/projects/:id/materials/upload", uploadFile, write((req) => Catalogue.uploadMaterial(pool, actorOf(req), req.params.id, req.files?.file?.[0], req.body), { show: showProject, done: (req) => `${projectUrl(req)}#materials` }));
  web.post("/catalogue/projects/:id/materials/:mid/visibility", write((req) => Catalogue.setMaterialVisibility(pool, actorOf(req), req.params.id, req.params.mid, req.body.visible === "1"), { show: showProject, done: (req) => `${projectUrl(req)}#materials` }));
  web.post("/catalogue/projects/:id/materials/:mid/delete", write((req) => Catalogue.deleteMaterial(pool, actorOf(req), req.params.id, req.params.mid), { show: showProject, done: (req) => `${projectUrl(req)}#materials` }));
  web.post("/catalogue/projects/:id/units", write((req) => Catalogue.linkUnits(pool, actorOf(req), req.params.id, { codes: req.body.codes, phaseId: req.body.phase_id || null }), {
    show: showProject,
    done: (req, r) => `${projectUrl(req, `saved=linked${r.missing.length ? `&missing=${encodeURIComponent(r.missing.join(" "))}` : ""}`)}#units`
  }));
  web.post("/catalogue/projects/:id/units/:lid/unlink", write((req) => Catalogue.unlinkUnit(pool, actorOf(req), req.params.id, req.params.lid), { show: showProject, done: (req) => `${projectUrl(req)}#units` }));
}

module.exports = { register };
