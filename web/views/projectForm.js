// web/views/projectForm.js — Add/edit a project, built like the add/edit unit form: sections as cards (add walks them one at a time,
// edit shows all of them), a paste box that reads a launch message for free, the unit box for the place and features, a
// searchable developer list with "add a new one", and clear required (*) and optional fields.
"use strict";

const Rules = require("../../domain/fieldRules");
const Describe = require("../../domain/describe");
const { html, raw } = require("../html");
const { unitBox, input, select, head, ICON } = require("./unitForm");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const pick = (pair, lang) => (pair ? (lang === "en" ? pair[1] : pair[0]) : "");
const chk = (on) => (on ? raw(" checked") : "");
const val = (v) => (v === null || v === undefined ? "" : String(v));
const TYPES = ["apartment", "duplex", "penthouse", "studio", "villa", "townhouse", "twin_villa", "chalet", "office", "clinic", "shop", "commercial"].filter((t) => Rules.PROPERTY_TYPES.includes(t));
const STATUS = { launching: ["إطلاق جديد", "New launch"], selling: ["متاح للبيع", "Selling"], sold_out: ["اتباع بالكامل", "Sold out"] };
const pill = (name, value, on, label) => html`<label class="pill"><input type="checkbox" name="${name}" value="${value}"${chk(on)}><span>${label}</span></label>`;
const opt = (lang) => L(lang, " (اختياري)", " (optional)");

/**
 * @param {Object} p - { values (the project row, or the form again after an error), mode: "new"|"edit", action, lang, areas, place (the box's place chip),
 *   developer ({id, name} or null), error, cancelHref }
 */
function projectForm({ values: v = {}, mode = "new", action, lang = "ar", areas = [], place = null, developer = null, error = null, cancelHref = "/app/catalogue", sourceText = "" }) {
  const stepped = mode === "new" && !error;
  const steps = [L(lang, "المشروع والمكان", "Project and place"), L(lang, "الأرقام والأسعار", "Numbers and prices"), L(lang, "المطور والصور", "Developer and photos")];
  const bedrooms = (v.bedroom_options || []).map(Number);
  const types = v.property_types || [];
  const feats = v.feature_keys || [];
  const boxValues = {
    compound: v.compound || "", area_id: v.area_id || "", subzone_id: v.subzone_id || "", feature: feats, features_other: (v.features_other || []).join("، "),
    compound_new: "", district: v.district || "", city: v.city || ""
  };
  const msgs = {
    read: L(lang, "اتقرا من الرسالة", "Read from the message"), none: L(lang, "ماقدرتش أقرا حاجة من الرسالة. اكتب التفاصيل بإيدك.", "Nothing could be read from the message. Type the details yourself."),
    check: L(lang, "راجع كل خانة قبل ما تحفظ.", "Check every field before you save."),
    new: L(lang, "جديد", "new"), add: L(lang, "ضيف «%s» كمطور جديد", "Add “%s” as a new developer"),
    known: L(lang, "المشروع ده موجود في الكتالوج", "This project is already in the catalogue"), open: L(lang, "افتحه", "Open it"),
    labels: JSON.stringify({
      name: L(lang, "الاسم", "name"), developer: L(lang, "المطور", "developer"), place: L(lang, "المكان", "place"), features: L(lang, "المميزات", "features"),
      area_acres: L(lang, "المساحة", "size"), delivery_raw: L(lang, "الاستلام", "delivery"), status: L(lang, "الحالة", "status"), price_from: L(lang, "السعر يبدأ من", "price from"),
      down_pct_min: L(lang, "المقدم", "down payment"), years_max: L(lang, "السنين", "years"), discount_pct: L(lang, "الخصم", "discount"), bedrooms: L(lang, "الغرف", "bedrooms"),
      property_types: L(lang, "النوع", "types"), offers: L(lang, "وحدات بأسعارها", "priced units"), facts: L(lang, "تفاصيل تانية", "other details"), delivery_year: L(lang, "سنة الاستلام", "delivery year")
    })
  };
  return html`<form id="project-form" method="post" action="${action}"${mode === "new" ? raw(' enctype="multipart/form-data"') : ""} class="stack uf${mode === "edit" ? " uf-edit" : ""}" data-progress data-project-form
    data-msg-read="${msgs.read}" data-msg-none="${msgs.none}" data-msg-check="${msgs.check}" data-msg-add="${msgs.add}" data-msg-new="${msgs.new}" data-msg-known="${msgs.known}" data-msg-open="${msgs.open}" data-labels="${msgs.labels}"${stepped ? html` data-steps="${steps.join("|")}" data-next="${L(lang, "التالي", "Next")}" data-prev="${L(lang, "رجوع", "Back")}"` : ""}>
  ${error ? html`<p class="card notice bad" role="alert">${error}</p>` : ""}
  <p class="uf-legend muted">${L(lang, "الخانات اللي عليها * مطلوبة. الباقي اختياري: املأ اللي الرسالة بتقوله بس.", "Fields marked * are required. Everything else is optional: fill only what the message says.")}</p>
  ${mode === "edit" ? html`<nav class="uf-jump" aria-label="${L(lang, "أقسام الفورم", "Form sections")}">${steps.map((s, i) => html`<a href="#pf-${i + 1}" data-step-link="${i + 1}">${s}</a>`)}</nav>` : ""}

  <section class="card uf-card stack" data-step="1" id="pf-1">
    ${head(1, steps[0], L(lang, "الصق رسالة المطور (إعلان واتساب)، ونقرا منها الاسم والمكان والأرقام. مجاني، من غير رصيد.", "Paste the developer's message (a WhatsApp ad) and we read the name, place and numbers from it. Free, no credits."))}
    <label>${L(lang, "رسالة المطور", "The developer's message")}${opt(lang)}<textarea name="paste_text" rows="4" data-ubox-source data-project-source maxlength="8000">${sourceText}</textarea></label>
    <div class="row uf-fill">
      <button type="button" data-project-read>${ICON.spark} ${L(lang, "اقرا الرسالة", "Read the message")}</button>
      <span class="muted small" data-project-found role="status"></span>
    </div>
    <p class="notice" data-project-known hidden></p>
    <div class="grid">
      ${input("name", L(lang, "اسم المشروع *", "Project name *"), v.name || "", { extra: ' required maxlength="120"' })}
      ${input("name_en", L(lang, `الاسم بالإنجليزي${opt(lang)}`, `Name in English${opt(lang)}`), v.name_en || "", { dir: "ltr", extra: ' maxlength="120"' })}
    </div>
    ${unitBox(boxValues, areas, lang, place, { areasOnly: true, label: L(lang, "المنطقة والمميزات *", "Area and features *") })}
    <p class="muted small">${L(lang, "المنطقة مطلوبة: اختار المنطقة أو المنطقة الفرعية (والمحافظة بتظهر منها). منطقة فرعية مش في القائمة تقدر تطلبها: بتفضل ليك لحد ما مالك النظام يوافق عليها. المميزات اختيارية: اللي بيتوفر في وحدات المشروع (روف، جنينة...).", "The area is required: pick the area or sub-area (the governorate follows from it). A sub-area that is not on the list can be requested: it is yours only until the CRM owner approves it. Features are optional: what the project's units offer (roof, garden…).")}</p>
  </section>

  <section class="card uf-card stack" data-step="2" id="pf-2">
    ${head(2, steps[1], L(lang, "كلها اختيارية. اللي مش مكتوب في الرسالة سيبه فاضي ومتخمنش.", "All optional. Leave blank what the message does not say; do not guess."))}
    <div class="grid">
      ${select("status", L(lang, `الحالة${opt(lang)}`, `Status${opt(lang)}`), v.status || "selling", Object.entries(STATUS).map(([k, t]) => [k, pick(t, lang)]))}
      ${input("price_from", L(lang, `السعر يبدأ من (ج.م)${opt(lang)}`, `Price from (EGP)${opt(lang)}`), val(v.price_from), { extra: ' inputmode="decimal" dir="ltr" placeholder="2,000,000"' })}
      ${input("area_acres", L(lang, `مساحة المشروع (فدان)${opt(lang)}`, `Project size (feddan)${opt(lang)}`), val(v.area_acres), { extra: ' inputmode="decimal" dir="ltr"' })}
      ${input("down_pct_min", L(lang, `أقل مقدم %${opt(lang)}`, `Lowest down payment %${opt(lang)}`), val(v.down_pct_min), { extra: ' inputmode="decimal" dir="ltr"' })}
      ${input("years_max", L(lang, `أطول تقسيط (سنين)${opt(lang)}`, `Longest term (years)${opt(lang)}`), val(v.years_max), { extra: ' inputmode="decimal" dir="ltr"' })}
      ${input("discount_pct", L(lang, `خصم %${opt(lang)}`, `Discount %${opt(lang)}`), val(v.discount_pct), { extra: ' inputmode="decimal" dir="ltr"' })}
      ${input("maintenance_pct", L(lang, `الصيانة %${opt(lang)}`, `Maintenance %${opt(lang)}`), val(v.maintenance_pct), { extra: ' inputmode="decimal" dir="ltr"' })}
    </div>
    <fieldset class="uf-set"><legend>${L(lang, `عدد الغرف${opt(lang)}`, `Bedrooms${opt(lang)}`)}</legend>
      <div class="pills" data-project-bedrooms>${[1, 2, 3, 4, 5, 6].map((n) => pill("bedrooms", n, bedrooms.includes(n), n))}</div></fieldset>
    <fieldset class="uf-set"><legend>${L(lang, `أنواع الوحدات${opt(lang)}`, `Unit types${opt(lang)}`)}</legend>
      <div class="pills" data-project-types>${TYPES.map((t) => pill("property_types", t, types.includes(t), pick(Describe.TYPE_LABELS[t], lang)))}</div></fieldset>
    <div class="grid">
      ${input("delivery_year", L(lang, `سنة الاستلام${opt(lang)}`, `Delivery year${opt(lang)}`), val(v.delivery_year), { extra: ' inputmode="numeric" dir="ltr" placeholder="2028"' })}
      ${input("delivery_quarter", L(lang, `الربع (1-4)${opt(lang)}`, `Quarter (1-4)${opt(lang)}`), val(v.delivery_quarter), { extra: ' inputmode="numeric" dir="ltr"' })}
      ${input("delivery_raw", L(lang, `الاستلام زي ما اتكتب${opt(lang)}`, `Delivery as written${opt(lang)}`), v.delivery_raw || "", { extra: ' maxlength="80" placeholder="' + L(lang, "مثلاً: استلام بعد سنة", "e.g. delivery in one year") + '"' })}
    </div>
  </section>

  <section class="card uf-card stack" data-step="3" id="pf-3">
    ${head(3, steps[2], L(lang, "اختار المطور من القايمة أو ضيف واحد جديد، وضيف صور لو معاك.", "Pick the developer from the list or add a new one, and add photos if you have them."))}
    <div class="ubox devbox" data-devbox data-url="/app/catalogue/developers/suggest">
      <label for="dev-input">${L(lang, `المطور${opt(lang)}`, `Developer${opt(lang)}`)}</label>
      <input id="dev-input" type="text" data-dev-input autocomplete="off" value="${developer ? developer.name : ""}" placeholder="${L(lang, "ابحث باسم المطور أو اكتب اسم جديد", "Search a developer, or type a new name")}" aria-autocomplete="list" aria-controls="dev-list">
      <div class="ubox-list" id="dev-list" data-dev-list role="listbox" hidden></div>
      <input type="hidden" name="developer_id" value="${developer && developer.id ? developer.id : ""}" data-dev-id>
      <input type="hidden" name="developer_global_id" value="${developer && developer.global_id ? developer.global_id : ""}" data-dev-global>
      <input type="hidden" name="developer_name" value="${developer && !developer.id && !developer.global_id ? developer.name : ""}" data-dev-new>
      <p class="ubox-context" data-dev-state${developer ? "" : raw(" hidden")}>${ICON.pin}<span data-dev-state-text>${developer ? (developer.id ? developer.name : L(lang, `${developer.name} (مطور جديد)`, `${developer.name} (new developer)`)) : ""}</span></p>
    </div>
    <label>${L(lang, `ملاحظات المشروع${opt(lang)}`, `Project notes${opt(lang)}`)} <span class="muted small">${L(lang, "(البروكرز بيشوفوها والمساعد بيجاوب منها، متكتبش العمولة هنا)", "(brokers see them and Ask answers from them; never put commission here)")}</span><textarea name="notes" maxlength="1000" rows="2">${v.notes || ""}</textarea></label>
    <label>🔒 ${L(lang, `لوكيشن المشروع (للشركة بس): لينك جوجل ماب${opt(lang)}`, `Project location (agency only): Google Maps link${opt(lang)}`)} <input name="pin" dir="ltr" autocomplete="off" value="${v.lat != null ? `${v.lat}, ${v.lng}` : ""}"></label>
    ${mode === "new" ? html`<fieldset data-new-materials class="uf-set"><legend>${L(lang, `صور وملفات${opt(lang)}`, `Photos and files${opt(lang)}`)}</legend>
      <label>${L(lang, "صور المشروع (حتى 10، بتظهر في كاروسيل زي صفحة الوحدة)", "Project photos (up to 10; shown as a carousel like the unit page)")} <input type="file" name="doc" accept="image/jpeg,image/png,image/webp" multiple></label>
      <label>${L(lang, "بروشور أو ملف (PDF أو صورة، لحد 25 ميجا)", "Brochure or file (PDF or photo, up to 25 MB)")} <input type="file" name="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>
      <label>${L(lang, "أو لينك (Drive، موقع المطور...)", "Or a link (Drive, developer site…)")} <input name="material_url" type="url" dir="ltr" placeholder="https://"></label>
      <label class="check"><input type="checkbox" name="material_client_visible" value="1"> ${L(lang, "يظهر للعميل", "Show to clients")}</label>
      <p class="muted small">${L(lang, "ملف أنظمة السداد (PDF أو إكسيل) بتحمله من صفحة المشروع بعد الحفظ، ويتقرا منه الأنظمة.", "A payment plans file (PDF or Excel) is uploaded on the project page after saving; the plans are read from it.")}</p>
    </fieldset>` : ""}
  </section>

  <div class="row uf-save" data-step="3" data-save-row>
    <button type="submit" data-project-save>${mode === "edit" ? L(lang, "حفظ المشروع", "Save project") : L(lang, "إضافة المشروع", "Add project")}</button>
    <a class="btn secondary" href="${cancelHref}">${L(lang, "إلغاء", "Cancel")}</a>
  </div>
</form>`;
}

module.exports = { projectForm, STATUS };
