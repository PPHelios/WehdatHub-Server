// web/routes/units.js — Units in the web app: the agency's list and one unit's page (agency-scoped)
"use strict";

const Stages = require("../../domain/leadStages");
const Store = require("../../lib/listingStore");
const Authz = require("../../lib/authz");
const Describe = require("../../domain/describe");
const Share = require("../../lib/shareLinks");
const LeadRequests = require("../../services/leadRequests");
const Card = require("../../domain/leadCard");
const Storage = require("../../lib/supabase");
const Insights = require("../../services/priceInsights");
const Catalogue = require("../../services/catalogue");
const PriceSheets = require("../../services/priceSheets");
const Leases = require("../../services/leases");
const LeaseRules = require("../../domain/leases");
const Commission = require("../../domain/commission");
const { icon } = require("../icons");
const Privacy = require("../../services/unitPrivacy");
const Portfolio = require("../../services/privatePortfolio");
const { unitOwnerBlock } = require("./owners");
const Owners = require("../../services/unitOwners");
const Bulk = require("../../services/bulk");
const { logOperation } = require("../../lib/db");
const { html } = require("../html");
const { resultItem, factList } = require("../views/units");
const Vis = require("../../lib/visibility");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const STATUSES = ["active", "sold", "archived"];
const UNITS_PAGE = 20;
const { PROPERTY_TYPES } = require("../../domain/fieldRules");
const UnitDelete = require("../../services/unitDelete");
const Recipients = require("../../services/linkRecipients");
const Phone = require("../../domain/phone");
const Deal = require("../../domain/dealType");
const DAY_MS = 24 * 3600 * 1000;
const deletedDaysLeft = (r) => Math.max(0, Math.ceil((new Date(r.deleted_at).getTime() + UnitDelete.RETENTION_DAYS * DAY_MS - Date.now()) / DAY_MS));
const { FURNISHING_STATUSES, FINISHING_STATUSES } = require("../../domain/furnishingStatus");

async function imagesOf(pool, listing) {
  const { rows } = await pool.query("SELECT id, url, position FROM listing_images WHERE listing_id = $1 AND agency_id = $2 ORDER BY position", [
    listing.id,
    listing.agency_id
  ]);
  return rows.map((r) => ({ ...r, url: Storage.photoUrl(r.url) }));
}

/** Wow 1: "🔥 N clients want this unit", the broker's own listed with Send (the count is the agency's). */
async function wantedSection(pool, broker, listing, lang, csrf) {
  const w = await LeadRequests.whoWants(pool, broker, listing);
  if (!w.total) return "";
  return html`<section class="card" id="wanted"><h2>🔥 ${L(lang, `${w.total} عملاء عايزين الوحدة دي`, `${w.total} clients want this unit`)}</h2>
  <ul>${w.leads.map(
    (l) => html`<li data-lead="${Card.refLabel(l.ref)}"><a href="/app/leads/${Card.refLabel(l.ref)}">${Card.refLabel(l.ref)} · ${Card.displayName(l, lang)}</a>
    <form method="post" action="/app/leads/${Card.refLabel(l.ref)}/send" class="inline" target="_blank"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="code" value="${listing.code}"><button type="submit" class="link">💬 ${L(lang, "ابعت للعميل", "Send to client")}</button></form></li>`
  )}</ul>
  ${w.others ? html`<p class="muted">👥 ${L(lang, `و${w.others} مع زملائك.`, `And ${w.others} with your colleagues.`)}</p>` : ""}
</section>`;
}

/** "EGP 52,000 per m² · 8% above the median of 12 units in Hyde Park" (sale and rent apart; ≥ 5 other units). */
/** The unit's catalogue project (C1) and its links; internal ones are marked (brokers may use them, clients never see them). */
function projectLine(p, lang, { catalogue = true } = {}) {
  const fresh = PriceSheets.freshness(p);
  const delivery = p.delivery_year ? `${p.delivery_quarter ? `Q${p.delivery_quarter} ` : ""}${p.delivery_year}` : p.delivery_raw || "";
  return html`<p data-project="${p.id}">🏗️ <a href="/app/catalogue/projects/${p.id}">${lang === "en" ? p.name_en || p.name : p.name}</a>${p.developer_name ? ` · ${p.developer_name}` : ""}${delivery ? html` · <span data-project-delivery>🔑 ${L(lang, "تسليم المشروع", "project delivery")} <span dir="ltr">${delivery}</span></span>` : ""}${catalogue && p.prices_updated_at ? html` · <span data-prices-fresh="${fresh}">${fresh === "stale" ? "⚠️ " : "🏷️ "}${L(lang, "أسعار شيت", "prices of")} <span dir="ltr">${new Date(p.prices_updated_at).toISOString().slice(0, 10)}</span>${fresh === "stale" ? L(lang, " (السعر ممكن يكون اتغير)", " (price may have changed)") : ""}</span>` : ""}</p>
  ${p.materials.length ? html`<p class="muted">${p.materials.map((m, i) => html`${i ? " · " : ""}<a href="${m.url}" target="_blank" rel="noopener noreferrer">${m.label}</a>${m.client_visible ? "" : " 🔒"}`)}</p>` : ""}`;
}

/** The unit's price history (C2), when its price changed at least once. */
function historyLine(rows, lang) {
  if (rows.length < 2) return "";
  return html`<details data-price-history><summary>📈 ${L(lang, "تاريخ السعر", "Price history")}</summary><ul>${rows.map((r) => html`<li><span dir="ltr">${new Date(r.changed_at).toISOString().slice(0, 10)}</span>: ${Commission.money(r.price, lang)}</li>`)}</ul></details>`;
}

/** C3: link a broker's own resale unit to a catalogue project (its contract keeps its own terms). */
function resaleLinkForm(listing, project, projects, lang, csrf) {
  if (!projects.length && !project) return "";
  return html`<details id="resale-project" ${project ? "" : "open"}><summary>🏗️ ${L(lang, "ربط الوحدة بمشروع في الكتالوج", "Link this unit to a catalogue project")}</summary>
  <form method="post" action="/app/units/${encodeURIComponent(listing.code)}/project" class="row">
    <input type="hidden" name="_csrf" value="${csrf}">
    <select name="project_id"><option value="">${L(lang, "— بدون مشروع —", "— No project —")}</option>${projects.map((p) => html`<option value="${p.id}" ${p.id === listing.project_id ? "selected" : ""}>${lang === "en" ? p.name_en || p.name : p.name}</option>`)}</select>
    <button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>
  </form>
  <p class="muted">${L(lang, "العقد بيفضل بشروط الدفع بتاعته. المشروع بيظهر التسليم والروابط بس.", "The contract keeps its own payment terms. The project adds its delivery and links only.")}</p>
</details>`;
}

function marketLine(m, listing, lang) {
  const n = (x) => Number(x).toLocaleString("en-US");
  const diff = m.diffPct === null || Math.abs(m.diffPct) < 3
    ? L(lang, "قريب من", "close to")
    : m.diffPct > 0 ? L(lang, `أعلى ${m.diffPct}% من`, `${m.diffPct}% above`) : L(lang, `أقل ${-m.diffPct}% من`, `${-m.diffPct}% below`);
  return html`<p class="muted" data-market="${m.diffPct}">📊 ${n(m.perM2)} ${L(lang, "ج.م للمتر", "EGP per m²")}${listing.listing_type === "rent" ? L(lang, " في الشهر", " a month") : ""} · ${diff} ${L(lang, `وسيط ${m.units} وحدة${Insights.likeLabel(m, lang) ? ` (${Insights.likeLabel(m, lang)})` : ""} في ${m.place}`, `the median of ${m.units} ${Insights.likeLabel(m, lang) ? `${Insights.likeLabel(m, lang)} ` : ""}units in ${m.place}`)} (${n(m.median)}) · <a href="/app/insights">${L(lang, "أسعار المتر", "Prices per m²")}</a></p>`;
}

/** N4: the lease card on a rent unit (who may edit it). */
function leaseSection(listing, lease, lang, csrf, notice, tenants = []) {
  const end = lease ? LeaseRules.ymd(LeaseRules.endDate(lease)) : null;
  const notes = { saved: L(lang, "✅ الإيجار اتحفظ.", "✅ Lease saved."), removed: L(lang, "الإيجار اتمسح.", "Lease removed."), bad_start_date: L(lang, "اختار تاريخ بداية.", "Choose a start date."), bad_months: L(lang, "المدة بالشهور من 1 لـ 120.", "Length in months, 1 to 120."), bad_rent: L(lang, "الإيجار مش مفهوم.", "The rent isn't valid."), bad_increase_pct: L(lang, "الزيادة من 0 لـ 100%.", "Increase from 0 to 100%."), bad_not_rent: L(lang, "الوحدة دي مش إيجار.", "This unit isn't for rent."), bad_bad_tenant: L(lang, "رقم العميل (L-…) مش موجود.", "That lead reference (L-…) doesn't exist.") };
  return html`<section class="card stack" id="lease" data-lease="${lease ? "yes" : "no"}">
  <h2>🔑 ${L(lang, "عقد الإيجار والتذكير بالتجديد", "Lease and renewal reminders")}</h2>
  ${notice && notes[notice] ? html`<p class="notice" data-lease-notice="${notice}">${notes[notice]}</p>` : ""}
  <p class="muted">${L(lang, "اختياري: لو الوحدة اتأجرت، سجل بداية العقد ومدته. لو علّمت «فكرني»، هتوصلك رسالة قبل نهاية العقد بـ 60 و30 يوم، وقبل كل زيادة سنوية بـ 30 يوم.", "Optional: once the unit is rented, enter the lease start and length. With \"remind me\" ticked you hear 60 and 30 days before it ends, and 30 days before each yearly increase.")}</p>
  ${lease ? html`<p data-lease-end>${L(lang, `العقد بيخلص ${end}`, `The lease ends ${end}`)}${lease.remind ? " · 🔔" : ""}</p>` : ""}
  <form method="post" action="/app/units/${encodeURIComponent(listing.code)}/lease" class="grid">
    <input type="hidden" name="_csrf" value="${csrf}">
    <label>${L(lang, "المستأجر: رقم العميل (L-0042) أو الاسم (اختياري)", "Tenant: lead ref (L-0042) or name (optional)")}<input name="tenant_name" maxlength="120" list="tenant-leads" autocomplete="off" value="${lease?.tenant_name || ""}"></label>
    <datalist id="tenant-leads">${tenants.map((t) => html`<option value="${t.label}"></option>`)}</datalist>
    <label>${L(lang, "بداية العقد", "Lease start")}<input type="date" name="start_date" required value="${lease ? LeaseRules.ymd(lease.start_date) : Stages.cairoDay()}"></label>
    <label>${L(lang, "المدة (شهور)", "Length (months)")}<input type="number" name="months" min="1" max="120" required value="${lease?.months || 12}"></label>
    <label>${L(lang, "الإيجار الشهري (اختياري)", "Monthly rent (optional)")}<input name="rent" inputmode="numeric" value="${lease?.rent ? Math.round(Number(lease.rent)) : ""}"></label>
    <label>${L(lang, "الزيادة السنوية % (اختياري)", "Yearly increase % (optional)")}<input name="increase_pct" inputmode="decimal" value="${lease?.increase_pct ?? ""}"></label>
    <label class="check"><input type="checkbox" name="remind" value="1"${lease?.remind ? html` checked` : ""}> ${L(lang, "فكرني بالتجديد والزيادة", "Remind me about renewal and increases")}</label>
    <button type="submit">${L(lang, "حفظ", "Save")}</button>
  </form>
  ${lease ? html`<form method="post" action="/app/units/${encodeURIComponent(listing.code)}/lease"><input type="hidden" name="_csrf" value="${csrf}"><input type="hidden" name="remove" value="1"><button type="submit" class="secondary">${L(lang, "امسح العقد", "Remove the lease")}</button></form>` : ""}
</section>`;
}

/** F10: the agency's leads to pick a tenant from (tenants first, then the most recent), as "L-0042 Name". */
// The list shows cards only: the long text and cached-flyer columns are not read (every other column stays, so cards render as before).
const LIST_COLS = "id,code,agency_id,broker_id,status,title,property_type,listing_type,price_value,price_display,area_value,bedrooms,location,features,language,lat,lng,location_name,details,flyer_url,hero_position,is_primary_developer,down_payment_value,installment_years,installment_value,payment_frequency,delivery_date,maintenance_pct,created_at,updated_at,compound,district,city,location_keywords,flyer_wa_media_id,flyer_wa_media_at,project_id,inventory_type,developer_unit_code,payment_terms,bathrooms,compound_en,delivery_year,delivery_quarter,delivery_month,is_ready,delivery_raw,feature_keys,features_other,remaining_amount,installments_end,confirmed_at,market,finishing,furnishing,floor_level,version,code_norm,compound_key,developer_key,area_key,stale_asked_at,stale_hidden_at,phase_id,is_private,owner_id,portal_listing_no,deleted_at,deleted_by";

function register(web, { pool, page }) {
  /** The units list; a bulk edit's answer shows on top of it (notice). */
  async function unitsList(req, res, { notice = null, code = 200 } = {}) {
    const lang = langOf(req);
    const { broker } = req.session;
    // Recently deleted (soft delete, services/unitDelete.js) is for managers and the owner only.
    const status = req.query.status === "deleted" && Authz.isManager(broker) ? "deleted" : STATUSES.includes(req.query.status) ? req.query.status : "active";
    const mine = req.query.mine === "1";
    const onlyPrivate = req.query.private === "1" && Authz.isAgencyOwner(broker);
    // Filters: fixed lists (type, furnishing, finishing), the agency's own compounds, and a search on the code.
    const oneOf = (v, list) => (list.includes(String(v || "")) ? String(v) : "");
    const type = oneOf(req.query.type, PROPERTY_TYPES);
    const furnishing = oneOf(req.query.furnishing, [...FURNISHING_STATUSES, "none"]);
    const finishing = oneOf(req.query.finishing, [...FINISHING_STATUSES, "none"]);
    const deal = Deal.clean(req.query.deal);
    const pmin = String(req.query.pmin || "").slice(0, 20);
    const pmax = String(req.query.pmax || "").slice(0, 20);
    const q = String(req.query.q || "").trim().slice(0, 40);
    const pageNo = Math.max(0, Math.min(parseInt(req.query.page, 10) || 0, 10000));
    const { rows: compounds } = await pool.query(
      `SELECT compound, count(*)::int AS n FROM listings WHERE ${Vis.units("listings")} AND agency_id = $1 AND status = $2 AND coalesce(compound, '') <> ''
       GROUP BY compound ORDER BY compound`,
      [broker.agency_id, status]
    );
    const wanted = String(req.query.compound || "").trim().toLowerCase();
    const compound = wanted ? compounds.find((c) => c.compound.toLowerCase() === wanted)?.compound || "" : "";
    const args = [broker.agency_id, status];
    const where = ["agency_id = $1", "status = $2"];
    const add = (sql, v) => {
      args.push(v);
      where.push(sql.split("?").join(`$${args.length}`));
    };
    if (mine) add("broker_id = ?", broker.id);
    if (onlyPrivate) where.push("is_private");
    if (compound) add("compound = ?", compound);
    if (type) add("property_type = ?", type);
    if (furnishing === "none") where.push("furnishing IS NULL");
    else if (furnishing) add("furnishing = ?", furnishing);
    if (finishing === "none") where.push("finishing IS NULL");
    else if (finishing) add("finishing = ?", finishing);
    if (deal) where.push(Deal.sql(deal, ""));
    if (Deal.parseMoney(pmin)) add("price_value >= ?", Deal.parseMoney(pmin));
    if (Deal.parseMoney(pmax)) add("price_value <= ?", Deal.parseMoney(pmax));
    if (q) add("(code ILIKE '%' || ? || '%' OR developer_unit_code ILIKE '%' || ? || '%')", q.replace(/[%_\\]/g, (c) => `\\${c}`));
    const cond = where.join(" AND ");
    const total = (await pool.query(`SELECT count(*)::int AS n FROM listings WHERE ${Vis.units("listings")} AND ${cond}`, args)).rows[0].n;
    // Counts for the three status tabs (same visibility rule as the list itself).
    const statusCounts = Object.fromEntries(
      (await pool.query(`SELECT status, count(*)::int AS n FROM listings WHERE ${Vis.units("listings")} AND agency_id = $1 AND status IN ('active', 'sold', 'archived') GROUP BY status`, [broker.agency_id])).rows.map((r) => [r.status, r.n])
    );
    const { rows } = await pool.query(
      `SELECT ${LIST_COLS} FROM listings WHERE ${Vis.units("listings")} AND ${cond} ORDER BY confirmed_at DESC NULLS LAST, created_at DESC, id DESC LIMIT ${UNITS_PAGE} OFFSET ${pageNo * UNITS_PAGE}`,
      args
    );
    const link = (over = {}) => {
      const p = new URLSearchParams();
      const all = { status, mine: mine ? "1" : "", private: onlyPrivate ? "1" : "", q, compound, type, furnishing, finishing, deal, pmin, pmax, ...over };
      for (const [k, v] of Object.entries(all)) if (v !== "" && v !== null && v !== undefined) p.set(k, v);
      return `/app/units?${p.toString()}`;
    };
    const tab = (st, label, n) => html`<a href="${link({ status: st, page: "" })}"${st === status ? html` aria-current="page"` : ""}>${label}${n !== undefined ? html` <span class="muted">(${n})</span>` : ""}</a>`;
    const active = [compound, type, furnishing, finishing, deal, pmin, pmax].filter(Boolean).length;
    const opt = (v, cur, label) => html`<option value="${v}"${v === cur ? html` selected` : ""}>${label}</option>`;
    const lab = (map, key) => (lang === "en" ? map[key][1] : map[key][0]);
    const pages = Math.max(1, Math.ceil(total / UNITS_PAGE));
    return page(req, res, {
      title: L(lang, "الوحدات", "Units"),
      nav: "units",
      body: html`<div class="row between"><h1>${L(lang, "الوحدات", "Units")}</h1><a class="btn small" href="/app/units/new">${icon("plus", 18)} ${L(lang, "وحدة", "Unit")}</a><a class="btn secondary small" href="/app/owners">👤 ${L(lang, "المُلّاك", "Owners")}</a></div>
${notice || ""}
<nav class="seg" aria-label="${L(lang, "الحالة", "Status")}">
  ${tab("active", L(lang, "نشطة", "Active"), statusCounts.active || 0)}${tab("sold", L(lang, "مباعة", "Sold"), statusCounts.sold || 0)}${tab("archived", L(lang, "مؤرشفة", "Archived"), statusCounts.archived || 0)}${Authz.isManager(broker) ? tab("deleted", L(lang, "🗑️ المحذوفة", "🗑️ Recently deleted")) : ""}
</nav>
<form method="get" action="/app/units" class="stack" data-unit-filters>
  <input type="hidden" name="status" value="${status}">
  ${mine ? html`<input type="hidden" name="mine" value="1">` : ""}${onlyPrivate ? html`<input type="hidden" name="private" value="1">` : ""}
  <div class="searchbox">${icon("search", 20)}<input id="unit-q" hx-preserve="true" hx-get="/app/units" hx-include="closest form" hx-select="main" hx-target="main" hx-swap="innerHTML" hx-trigger="input changed delay:300ms" hx-push-url="true" name="q" value="${q}" dir="ltr" aria-label="${L(lang, "بحث بكود الوحدة", "Search by unit code")}" placeholder="${L(lang, "كود الوحدة", "Unit code")}"><button type="submit" class="sr-only">${L(lang, "بحث", "Search")}</button></div>
  <details class="card sheet"${active ? html` open` : ""}><summary>${L(lang, "الفلاتر", "Filters")}${active ? html` <span class="chip">${active}</span>` : ""}</summary>
  <div class="grid two">
    <label>${L(lang, "الكمبوند", "Compound")}<input name="compound" list="unit-compounds" value="${compound}" autocomplete="off" placeholder="${L(lang, "اكتب للبحث", "Type to search")}"><datalist id="unit-compounds">${compounds.map((c) => html`<option value="${c.compound}">${c.n}</option>`)}</datalist></label>
    <label>${L(lang, "نوع الوحدة", "Unit type")}<select name="type"><option value="">${L(lang, "الكل", "All")}</option>${PROPERTY_TYPES.map((t) => opt(t, type, lab(Describe.TYPE_LABELS, t)))}</select></label>
    <label>${L(lang, "الفرش", "Furnishing")}<select name="furnishing"><option value="">${L(lang, "الكل", "All")}</option>${FURNISHING_STATUSES.map((t) => opt(t, furnishing, lab(Describe.FURNISHING_LABELS, t)))}${opt("none", furnishing, L(lang, "مش محدد", "Not stated"))}</select></label>
    <label>${L(lang, "التشطيب", "Finishing")}<select name="finishing"><option value="">${L(lang, "الكل", "All")}</option>${FINISHING_STATUSES.map((t) => opt(t, finishing, lab(Describe.FINISHING_LABELS, t)))}${opt("none", finishing, L(lang, "مش محدد", "Not stated"))}</select></label>
    <label>${L(lang, "نوع الصفقة", "Deal type")}<select name="deal"><option value="">${L(lang, "الكل", "All")}</option>${Deal.DEALS.map((t) => opt(t, deal, Deal.label(t, lang)))}</select></label>
    <label>${L(lang, "السعر من", "Price from")}<input name="pmin" value="${pmin}" inputmode="text" dir="ltr" placeholder="${L(lang, "مثلا 3m", "e.g. 3m")}"></label>
    <label>${L(lang, "السعر إلى", "Price to")}<input name="pmax" value="${pmax}" inputmode="text" dir="ltr" placeholder="${L(lang, "مثلا 6m", "e.g. 6m")}"></label>
  </div>
  <div class="row sheet-actions"><button type="submit">${L(lang, "تطبيق", "Apply")}</button><a class="btn secondary" href="${link({ q: "", compound: "", type: "", furnishing: "", finishing: "", deal: "", pmin: "", pmax: "" })}">${L(lang, "مسح", "Clear")}</a></div>
  </details>
</form>
<p class="row between small">
  <a class="pill-link${mine ? " on" : ""}" href="${link({ mine: mine ? "" : "1", page: "" })}"${mine ? html` aria-pressed="true"` : ""}>${icon(mine ? "check" : "leads", 16)} ${L(lang, "وحداتي بس", "Mine only")}</a>
  ${Authz.isAgencyOwner(broker) ? html`<a class="pill-link${onlyPrivate ? " on" : ""}" href="${link({ private: onlyPrivate ? "" : "1", page: "" })}">⭐ ${L(lang, "VIP", "VIP")}</a>` : ""}
  <a href="/app/insights">${icon("chart", 16)} ${L(lang, "أسعار المتر", "Prices per m²")}</a>
</p>
${rows.length
  ? html`<p class="muted small" data-total="${total}">${L(lang, `${total} وحدة${pages > 1 ? ` · صفحة ${pageNo + 1} من ${pages}` : ""} · علّم الوحدات عشان تغيّر حالتها مرة واحدة.`, `${total} unit(s)${pages > 1 ? ` · page ${pageNo + 1} of ${pages}` : ""} · tick units to change them together.`)}</p>
${status === "deleted"
  ? html`<ol class="results">${rows.map((r) => html`<li class="card result" data-deleted-code="${r.code}"><div class="row between"><span><b dir="ltr">${r.code}</b> <span class="muted">${Describe.typeLabel(r, lang)}${r.compound ? ` · ${r.compound}` : ""}</span></span><span class="muted small">${L(lang, `تتمسح بعد ${deletedDaysLeft(r)} يوم`, `purged in ${deletedDaysLeft(r)} day(s)`)}</span></div><form method="post" action="/app/units/${encodeURIComponent(r.code)}/restore" class="row"><button type="submit" class="secondary small" data-restore>↩️ ${L(lang, "رجّعها", "Restore")}</button></form></li>`)}</ol>`
  : html`<ol class="results">${rows.map((r) => resultItem(r, lang, { selectable: true }))}</ol>`}
${pages > 1 ? html`<p class="row between">${pageNo > 0 ? html`<a class="btn secondary" href="${link({ page: pageNo - 1 })}">${L(lang, "→ السابق", "← Previous")}</a>` : html`<span></span>`} ${pageNo + 1 < pages ? html`<a class="btn secondary" href="${link({ page: pageNo + 1 })}">${L(lang, "التالي ←", "Next →")}</a>` : ""}</p>` : ""}
<form id="bulk" method="post" action="/app/units/bulk" class="bulkbar">
  <select name="action" aria-label="${L(lang, "للمختار", "Selected")}">
    <option value="available">${L(lang, "لسه متاحة (تأكيد)", "Still available (confirm)")}</option>
    <option value="sold">${L(lang, "اتباعت", "Sold")}</option>
    <option value="archive">${L(lang, "أرشفة", "Archive")}</option>
  </select>
  <button type="submit">${L(lang, "تطبيق على المختار", "Apply to selected")}</button>
</form>`
  : html`<div class="card empty"><p data-total="0">${active || q ? L(lang, "مفيش وحدات بالشروط دي.", "No units match.") : L(lang, "مفيش وحدات هنا.", "No units here.")}</p>${active || q ? "" : html`<a class="btn" href="/app/units/new">${L(lang, "ضيف وحدة", "Add a unit")}</a>`}</div>`}`
    }, code);
  }
  web.get("/units", (req, res) => unitsList(req, res));

  // Soft delete from the unit page (keeps 10 days); restore for managers and the owner.
  web.post("/units/:code/delete", async (req, res) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return res.status(404).type("text/plain").send("Not found");
    const out = await UnitDelete.softDelete(pool, broker, listing.id);
    if (out.error) return res.status(out.error === "forbidden" ? 403 : 400).type("text/plain").send(out.error);
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: listing.code, operation_type: "unit_soft_delete", metadata: {} });
    return res.redirect(303, "/app/units?status=deleted");
  });

  web.post("/units/:code/restore", async (req, res) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing) return res.status(404).type("text/plain").send("Not found");
    const out = await UnitDelete.restore(pool, broker, listing.id);
    if (out.error) return res.status(out.error === "forbidden" ? 403 : 400).type("text/plain").send(out.error);
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: listing.code, operation_type: "unit_restore", metadata: {} });
    return res.redirect(303, `/app/units/${encodeURIComponent(out.code)}`);
  });

  /* Status from the unit page: active, sold or archived. Brokers change their own units; managers and data entry change any non-VIP unit. */
  web.post("/units/:code/status", async (req, res) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return res.status(404).type("text/plain").send("Not found");
    const status = String(req.body.status || "");
    if (!["active", "sold", "archived"].includes(status)) return res.status(400).type("text/plain").send("Unknown status");
    if (listing.status === "deleted") return res.status(400).type("text/plain").send("Unit is deleted");
    if (!Authz.canEdit(broker, listing)) return res.status(403).type("text/plain").send("Not allowed");
    if (!(await require("../../services/unitRights").mayWrite(pool, broker))) return res.status(403).type("text/plain").send("Not allowed: the agency owner switched off unit changes for brokers");
    if (listing.status !== status) {
      const out = await Store.applyListingPatch(pool, broker, { listing, patch: { status } });
      if (out.conflict) return res.status(409).type("text/plain").send("Changed by someone else, try again");
      logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, listing_code: listing.code, operation_type: `listing_status_${status}`, metadata: { from: listing.status } });
    }
    return res.redirect(303, `/app/units/${encodeURIComponent(listing.code)}?saved=1`);
  });

  /* Bulk edit from the units list: the answer shows on the list itself. */
  web.post("/units/bulk", async (req, res) => {
    const lang = langOf(req);
    const { broker } = req.session;
    let out;
    try {
      out = await Bulk.bulkUpdate(pool, broker, { codes: [].concat(req.body.code || []), action: req.body.action, pct: req.body.pct });
    } catch (err) {
      if (err.code !== "INVALID_BULK") throw err;
      return unitsList(req, res, { code: 422, notice: html`<p class="card notice bad" role="alert">⚠️ ${L(lang, "اختار وحدات وإجراء صحيح (النسبة من -50% لـ +100%).", "Pick units and a valid action (percent from -50% to +100%).")}</p>` });
    }
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "web_bulk_edit", metadata: { action: req.body.action, pct: req.body.pct || null, updated: out.updated.length, forbidden: out.forbidden.length, conflicts: out.conflicts.length } });
    const line = (label, list) => (list.length ? html`<li data-outcome>${label}: ${list.length} <span class="muted">${list.join("، ")}</span></li>` : "");
    return unitsList(req, res, {
      notice: html`<div class="card notice ok" role="status" data-bulk-result>
  <ul>
    ${line(L(lang, "اتعدلت", "Updated"), out.updated)}
    ${line(L(lang, "مش من حقك تعدلها", "Not yours to change"), out.forbidden)}
    ${line(L(lang, "أسعار مطور (بتتعدل بشيت الأسعار)", "Developer prices (change them with the price sheet)"), out.skipped)}
    ${line(L(lang, "اتغيرت في نفس اللحظة، جرب تاني", "Changed at the same moment, try again"), out.conflicts)}
    ${line(L(lang, "مش موجودة", "Not found"), out.missing)}
  </ul>
</div>`
    });
  });

  /** Share section: a new client link (public page) and the broker's earlier links with their opens. */
  async function shareSection(broker, listing, lang, fresh = null) {
    if (listing.status !== "active") return "";
    const links = await Share.linksFor(pool, broker, listing);
    const copy = fresh ? `${Describe.clientCopy(listing, broker, { lang: fresh.lang })}\n\n🔗 ${fresh.url}` : null;
    return html`<section class="card" id="share">
  <h2>🔗 ${L(lang, "رابط للعميل", "Link for a client")}</h2>
  ${fresh
    ? html`<p class="share-url" data-share-url>${fresh.url}</p>
  <p><a class="btn" href="${(fresh.recipientPhone && Phone.waMeUrl(fresh.recipientPhone, copy)) || `https://wa.me/?text=${encodeURIComponent(copy)}`}" rel="noopener" data-send-whatsapp>${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>`
    : ""}
  <form method="post" action="/app/units/${encodeURIComponent(listing.code)}/share" class="stack" data-share-form>
    <label>${L(lang, "لمين؟ رقم العميل أو رقم العميل في النظام (L-0042). اختياري.", "To whom? Client's number or lead reference (L-0042). Optional.")}
      <input name="to" dir="ltr" inputmode="tel" maxlength="40" placeholder="01xxxxxxxxx · L-0042" autocomplete="off"></label>
    <label>${L(lang, "ملاحظة (اختياري)", "Note (optional)")} <input name="note" maxlength="200"></label>
    <div class="row">
      <select name="lang"><option value="ar">عربي</option><option value="en">English</option></select>
      <button type="submit" class="secondary">${L(lang, "رابط جديد", "New link")}</button>
    </div>
  </form>
  ${links.length
    ? html`<ul class="muted">${links.map(
        (k) => html`<li data-link-opens="${k.open_count}">${new Date(k.created_at).toISOString().slice(0, 10)} · ${k.channel}${k.recipient_phone ? html` · <span dir="ltr">${k.recipient_phone}</span>` : html` · ${L(lang, "من غير مستلم", "no recipient")}`} · ${L(lang, `اتفتح ${k.open_count} مرة`, `opened ${k.open_count} time(s)`)}${k.devices > 1 ? html` · ${L(lang, `من ${k.devices} أجهزة`, `from ${k.devices} devices`)}` : ""}${k.note ? html` · ${k.note}` : ""}</li>`
      )}</ul>`
    : ""}
  <p class="muted">${L(lang, "الصفحة بتظهر للعميل الصور والمواصفات بس — مفيش بيانات داخلية. هيوصلك تنبيه لما يفتحها.", "The page shows clients the photos and facts only — nothing internal. You get an alert when it is opened.")}</p>
</section>`;
  }

  web.post("/units/:code/share", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing) || listing.status !== "active") return next();
    const linkLang = req.body.lang === "en" ? "en" : "ar";
    const recipient = await Recipients.resolveRecipient(pool, broker, req.body.to);
    if (recipient.error) {
      const msg = recipient.error === "lead_not_found" ? L(lang, "العميل ده مش موجود عندك.", "No lead with that reference.") : L(lang, "رقم مش مظبوط (01xxxxxxxxx أو L-0042).", "That number isn't valid (01xxxxxxxxx or L-0042).");
      return page(req, res, { title: listing.code, nav: "units", body: html`<h1>${listing.code}</h1><p class="card notice bad" role="alert">❌ ${msg}</p>${await shareSection(broker, listing, lang)}` }, 400);
    }
    const fresh = await Share.createShareLink(pool, broker, listing, { channel: "web", lang: linkLang, recipient, source: "web", note: String(req.body.note || "").trim() || null });
    return page(req, res, { title: listing.code, nav: "units", body: html`<h1>${listing.code}</h1>${await shareSection(broker, listing, lang, { ...fresh, lang: linkLang })}<p><a href="/app/units/${encodeURIComponent(listing.code)}">${L(lang, "رجوع للوحدة", "Back to the unit")}</a></p>` });
  });

  // Photos to a client in one tap: the browser's share sheet (navigator.share with files) opens WhatsApp with the
  // pictures; Telegram can't forward several photos without its own captions and timestamps.
  web.get("/units/:code/share-media", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing) || listing.status !== "active") return next();
    const images = (await imagesOf(pool, listing)).slice(0, 10);
    const code = encodeURIComponent(listing.code);
    const text = Describe.clientCopy(listing, broker, { lang });
    return page(req, res, {
      title: listing.code,
      nav: "units",
      body: html`<h1>📤 ${L(lang, `صور ${listing.code} للعميل`, `${listing.code} photos for a client`)}</h1>
<section class="card stack" id="share-media" data-share-text="${text}">
  ${images.length
    ? html`<div class="photos">${images.map((i) => html`<img src="/app/units/${code}/photos/${i.id}" alt="" loading="lazy" data-share-photo>`)}</div>
  <button type="button" data-share-media>📤 ${L(lang, `ابعت ${images.length} صور (واتساب أو أي تطبيق)`, `Send ${images.length} photos (WhatsApp or any app)`)}</button>
  <p class="muted" data-share-status></p>
  <p class="muted">${L(lang, "لو الزرار مش شغال على جهازك: اضغط على الصورة مطولاً واحفظها، أو ابعت رابط الوحدة.", "If the button doesn't work on this device: long-press a photo to save it, or send the unit link.")}</p>`
    : html`<p class="muted">${L(lang, "مفيش صور للوحدة دي.", "This unit has no photos.")}</p>`}
</section>
<p><a href="/app/units/${code}">${L(lang, "رجوع للوحدة", "Back to the unit")}</a></p>`
    });
  });

  // One of the unit's photos served same-origin (the share page turns them into files for the share sheet).
  web.get("/units/:code/photos/:id", async (req, res, next) => {
    const { broker } = req.session;
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return next();
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return next();
    const { rows } = await pool.query("SELECT url FROM listing_images WHERE id = $1 AND listing_id = $2 AND agency_id = $3", [
      req.params.id,
      listing.id,
      listing.agency_id
    ]);
    const file = rows[0] ? await Storage.downloadListingImage(rows[0].url) : null;
    if (!file) return next();
    res.set({ "Content-Type": /^image\/(jpeg|png|webp)$/.test(file.mimeType) ? file.mimeType : "image/jpeg", "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
    return res.send(file.buffer);
  });

  web.post("/units/:code/project", async (req, res, next) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return next();
    const out = await Catalogue.linkResale(pool, broker, listing, req.body.project_id || null);
    if (out.error === "forbidden" || out.error === "catalogue_unit") return res.status(403).send("forbidden");
    if (out.error) return res.status(400).send("bad project");
    return res.redirect(303, `/app/units/${encodeURIComponent(listing.code)}?saved=1`);
  });

  // N4: the lease of a rented unit, with opt-in renewal and increase reminders (services/leases.js).
  web.post("/units/:code/lease", async (req, res, next) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return next();
    const out = req.body.remove === "1" ? await Leases.remove(pool, broker, listing) : await Leases.save(pool, broker, listing, req.body);
    if (out.error === "forbidden") return res.status(403).send(L(langOf(req), "مش مسموح.", "Not allowed."));
    return res.redirect(303, `/app/units/${encodeURIComponent(listing.code)}?lease=${out.error ? `bad_${out.error}` : req.body.remove === "1" ? "removed" : "saved"}#lease`);
  });

  /** The agency-only box: pin, unit number and address, the ask-for-access button, and open asks to answer. */
  async function privateSection(broker, listing, view, lang, csrf, notice) {
    const path = `/app/units/${encodeURIComponent(listing.code)}`;
    const hidden = html`<input type="hidden" name="_csrf" value="${csrf}">`;
    const notes = { saved: L(lang, "✅ اتحفظ.", "✅ Saved."), bad_pin: L(lang, "اللوكيشن مش مفهوم. الصق لينك جوجل ماب كامل أو الإحداثيات (30.04, 31.23).", "That location isn't clear. Paste a full Google Maps link or the coordinates (30.04, 31.23)."), asked: L(lang, "✅ طلبك اتبعت لصاحب الوحدة والمديرين.", "✅ Your ask went to the unit's broker and the managers."), answered: L(lang, "✅ اتسجل الرد.", "✅ Answer saved.") };
    if (!(await Privacy.canSee(pool, broker, listing))) {
      const asked = await Privacy.hasPending(pool, broker, listing);
      return html`<section class="card private" id="private">
  <h2>${icon("lock", 20)} ${L(lang, "بيانات خاصة بالشركة", "Agency-only details")}</h2>
  ${notice && notes[notice] ? html`<p class="notice ok">${notes[notice]}</p>` : ""}
  <p class="muted">${L(lang, "المالك والعمولة ورقم الوحدة والعنوان واللوكيشن بيشوفهم صاحب الوحدة والمديرين بس.", "The owner, commission, unit number, address and pin are for the unit's broker and the managers.")}</p>
  ${asked
    ? html`<p class="chip new">${L(lang, "طلبت تشوفها، مستني الرد", "You asked; waiting for an answer")}</p>`
    : html`<form method="post" action="${path}/access">${hidden}<button type="submit" class="secondary">${icon("lock", 18)} ${L(lang, "اطلب تشوفها", "Ask to see them")}</button></form>`}
</section>`;
    }
    const pin = await Privacy.pinOf(pool, listing);
    const d = listing.details || {};
    const editable = Authz.canEdit(broker, listing);
    const asks = await Privacy.pendingFor(pool, broker, listing);
    return html`<section class="card private stack" id="private">
  <h2>${icon("lock", 20)} ${L(lang, "اللوكيشن والعنوان (للشركة بس)", "Location and address (agency only)")}</h2>
  ${notice && notes[notice] ? html`<p class="notice ${notice.startsWith("bad") ? "bad" : "ok"}">${notes[notice]}</p>` : ""}
  <p class="muted small">${L(lang, "مش بيظهر في البحث ولا في روابط العملاء.", "Never shown in search or client links.")}</p>
  ${pin ? html`<p><a class="btn secondary" href="${Privacy.mapsUrl(pin)}" target="_blank" rel="noopener" data-pin>${icon("pin", 18)} ${L(lang, "افتح على الخريطة", "Open the map")}</a>${pin.from === "project" ? html` <span class="muted small">${L(lang, "(لوكيشن المشروع)", "(the project's pin)")}</span>` : ""}</p>` : ""}
  ${d.unit_no || d.address ? html`<p>${d.unit_no ? html`${L(lang, "رقم الوحدة", "Unit no.")}: <strong>${d.unit_no}</strong>` : ""}${d.unit_no && d.address ? " · " : ""}${d.address || ""}</p>` : ""}
  ${editable
    ? html`<details${pin || d.unit_no || d.address ? "" : html` open`}><summary>${pin || d.unit_no || d.address ? L(lang, "تعديل", "Edit") : L(lang, "ضيف اللوكيشن", "Add the location")}</summary>
  <form method="post" action="${path}/private" class="stack" data-pin-form>${hidden}
    <label>${L(lang, "لينك جوجل ماب أو الإحداثيات", "Google Maps link or coordinates")}<input name="pin" dir="ltr" autocomplete="off" value="${listing.lat != null ? `${listing.lat}, ${listing.lng}` : ""}" placeholder="https://maps.google.com/…"></label>
    <button type="button" class="secondary" data-my-location data-fail="${L(lang, "مقدرناش نجيب مكانك. الصق اللينك.", "Couldn't get your location. Paste the link.")}" hidden>${icon("pin", 18)} ${L(lang, "استخدم مكاني دلوقتي", "Use where I am now")}</button>
    <div class="grid two">
      <label>${L(lang, "رقم الوحدة", "Unit no.")}<input name="unit_no" maxlength="40" value="${d.unit_no || ""}"></label>
      <label>${L(lang, "العنوان", "Address")}<input name="address" maxlength="200" value="${d.address || ""}"></label>
    </div>
    <p class="muted small">${L(lang, "تقدر كمان تبعت لوكيشن للبوت وتختار الوحدة.", "You can also send a location pin to the bot and pick the unit.")}</p>
    <button type="submit">${L(lang, "حفظ", "Save")}</button>
  </form></details>`
    : ""}
  ${asks.length
    ? html`<div id="access" class="stack"><h3>${L(lang, "طلبات تشوف البيانات دي", "Asks to see these details")}</h3>${asks.map(
        (a) => html`<form method="post" action="${path}/access/${a.id}" class="row between">${hidden}<span>${a.name}</span><span class="row"><button type="submit" name="approve" value="1" class="small">${L(lang, "موافق", "Allow")}</button><button type="submit" name="approve" value="0" class="secondary small">${L(lang, "لأ", "Decline")}</button></span></form>`
      )}<p class="muted small">${L(lang, `الموافقة لمدة ${Privacy.GRANT_DAYS} يوم.`, `Access lasts ${Privacy.GRANT_DAYS} days.`)}</p></div>`
    : ""}
</section>`;
  }

  // The agency owner moves a unit in or out of the private portfolio.
  web.post("/units/:code/portfolio", async (req, res, next) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.isAgencyOwner(broker)) return next();
    await Portfolio.setPrivate(pool, broker, "unit", listing.id, req.body.value === "1");
    return res.redirect(303, `/app/units/${encodeURIComponent(listing.code)}`);
  });

  web.post("/units/:code/private", async (req, res, next) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canEdit(broker, listing)) return next();
    const raw = String(req.body.pin || "").trim();
    const pin = raw ? Privacy.parsePin(raw) : null;
    const back = (n) => res.redirect(303, `/app/units/${encodeURIComponent(listing.code)}?private=${n}#private`);
    if (raw && !pin) return back("bad_pin");
    await Privacy.setPin(pool, broker, listing, pin);
    const clean = (v, n) => String(v || "").trim().slice(0, n) || null;
    await pool.query(
      `UPDATE listings SET details = (details - 'unit_no' - 'address') || jsonb_strip_nulls(jsonb_build_object('unit_no', $3::text, 'address', $4::text)), updated_at = now() WHERE id = $1 AND agency_id = $2`,
      [listing.id, broker.agency_id, clean(req.body.unit_no, 40), clean(req.body.address, 200)]
    );
    return back("saved");
  });

  web.post("/units/:code/access", async (req, res, next) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return next();
    await Privacy.requestAccess(pool, broker, listing);
    const back = String(req.body.back || "");
    if (/^\/app\/(search|units)[?/\w=&%.-]*$/.test(back) && !back.includes("//")) return res.redirect(303, back);
    return res.redirect(303, `/app/units/${encodeURIComponent(listing.code)}?private=asked#private`);
  });

  web.post("/units/:code/access/:id", async (req, res, next) => {
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !/^\d{1,12}$/.test(req.params.id)) return next();
    const out = await Privacy.decide(pool, broker, listing, Number(req.params.id), req.body.approve === "1");
    if (!out.ok) return res.status(out.reason === "not_allowed" ? 403 : 404).send(L(langOf(req), "مش مسموح.", "Not allowed."));
    return res.redirect(303, `/app/units/${encodeURIComponent(listing.code)}?private=answered#private`);
  });

  web.get("/units/:code", async (req, res, next) => {
    const lang = langOf(req);
    const { broker } = req.session;
    const listing = await Store.findByCode(pool, broker.agency_id, req.params.code);
    if (!listing || !Authz.canView(broker, listing)) return next();
    const images = await imagesOf(pool, listing);
    const market = listing.status === "active" ? await Insights.forUnit(pool, listing) : null;
    const [project, prices] = await Promise.all([Catalogue.projectForUnit(pool, listing), PriceSheets.history(pool, listing)]);
    const status = { active: L(lang, "🟢 نشطة", "🟢 Active"), sold: L(lang, "🔴 مباعة", "🔴 Sold"), archived: L(lang, "📁 مؤرشفة", "📁 Archived"), deleted: L(lang, "🗑️ محذوفة", "🗑️ Deleted") }[listing.status] || listing.status;
    const linkable = !listing.details?.catalogue && listing.market === "resale" && listing.status === "active" && Authz.canEdit(broker, listing);
    const conf = Describe.compactLine({ code: "", confirmed_at: listing.confirmed_at }, lang).match(/✅ \S+/);
    const view = await Privacy.forBroker(pool, broker, listing);
    const priv = await privateSection(broker, listing, view, lang, req.session.csrf, req.query.private);
    return page(req, res, {
      title: listing.code,
      nav: "units",
      body: html`<article class="card" data-code="${listing.code}">
  ${req.query.saved ? html`<p class="notice card ok">✅ ${L(lang, "تم الحفظ", "Saved")}</p>` : ""}
  <h1>${listing.code} · ${status}${conf ? html` <span class="muted">${conf[0]}</span>` : ""}</h1>
  ${factList(view.listing, lang)}
  ${project ? projectLine(project, lang, { catalogue: Boolean(listing.details?.catalogue) }) : ""}
  ${listing.details?.owner_lead && Authz.canEdit(broker, listing) && !Authz.isDataEntry(broker) ? html`<p class="muted" data-owner-lead>🔗 ${L(lang, "المالك عميل عندك", "The owner is your client")}: <a href="/app/leads/${encodeURIComponent(listing.details.owner_lead)}">${listing.details.owner_lead}</a></p>` : ""}
  ${!view.hidden && (!Authz.isDataEntry(broker) || (await Owners.dataEntryOwnersOn(pool, broker.agency_id))) ? await unitOwnerBlock(pool, broker, listing, lang, req.session.csrf) : ""}
  ${linkable ? resaleLinkForm(listing, project, await Catalogue.listProjects(pool, broker), lang, req.session.csrf) : ""}
  ${market ? marketLine(market, listing, lang) : ""}
  ${historyLine(prices, lang)}
  ${images.length ? html`<div class="photos">${images.map((i) => html`<img src="${i.url}" alt="" loading="lazy">`)}</div>` : ""}
  ${Authz.canEdit(broker, listing) && listing.status !== "deleted" ? html`<form method="post" action="/app/units/${encodeURIComponent(listing.code)}/status" class="row" data-unit-status><input type="hidden" name="_csrf" value="${req.session.csrf}">
    <label>${L(lang, "الحالة", "Status")} <select name="status">${[["active", L(lang, "نشطة", "Active")], ["sold", L(lang, "مباعة", "Sold")], ["archived", L(lang, "مؤرشفة", "Archived")]].map(([v, t]) => html`<option value="${v}"${v === listing.status ? html` selected` : ""}>${t}</option>`)}</select></label>
    <button type="submit" class="secondary">${L(lang, "احفظ الحالة", "Save status")}</button>
  </form>` : ""}
  <div class="row" id="unit-actions">
    ${Authz.canEdit(broker, listing) ? html`<form method="post" action="/app/units/${encodeURIComponent(listing.code)}/delete" class="inline" data-confirm="${L(lang, "تحذف الوحدة؟ المدير يقدر يرجعها لمدة ١٠ أيام.", "Delete this unit? A manager can restore it for 10 days.")}"><button type="submit" class="secondary">🗑️ ${L(lang, "احذف", "Delete")}</button></form>` : ""}
    ${Authz.canEdit(broker, listing) ? html`<a class="btn" href="/app/units/${encodeURIComponent(listing.code)}/edit">✏️ ${L(lang, "تعديل", "Edit")}</a>` : ""}
    ${listing.status === "active" && !Authz.isDataEntry(broker) ? html`<a class="btn secondary" href="/app/compare?codes=${encodeURIComponent(listing.code)}" data-compare-start>⚖️ ${L(lang, "قارن", "Compare")}</a>` : ""}
    ${images.length && listing.status === "active" ? html`<a class="btn secondary" href="/app/units/${encodeURIComponent(listing.code)}/share-media">📤 ${L(lang, "ابعت الصور للعميل", "Send photos to a client")}</a>` : ""}
  </div>
  ${Authz.isAgencyOwner(broker) ? html`<form method="post" action="/app/units/${encodeURIComponent(listing.code)}/portfolio" class="row" data-portfolio><input type="hidden" name="_csrf" value="${req.session.csrf}"><input type="hidden" name="value" value="${listing.is_private ? "0" : "1"}"><button type="submit" class="secondary">${listing.is_private ? L(lang, "⭐ شيل الـ VIP", "Remove VIP") : L(lang, "⭐ خليها VIP", "Make VIP")}</button>${listing.is_private ? html`<span class="badge">⭐ ${L(lang, "VIP", "VIP")}</span>` : ""}</form>` : ""}
</article>
${priv}
${listing.listing_type === "rent" && Authz.canEdit(broker, listing) ? leaseSection(listing, await Leases.forListing(pool, listing), lang, req.session.csrf, req.query.lease, await Leases.tenantChoices(pool, broker)) : ""}
${listing.status === "active" && !Authz.isDataEntry(broker) ? await wantedSection(pool, broker, listing, lang, req.session.csrf) : ""}
${await shareSection(broker, listing, lang)}`
    });
  });
}

module.exports = { register, imagesOf };
