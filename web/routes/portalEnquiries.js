// web/routes/portalEnquiries.js — "Portal enquiries", a tab of Leads (/app/leads?tab=portal): managers and the owner. Each enquiry from
// Bayut, Dubizzle or Nawy: link to the unit (once per listing number), add the phone, assign a broker (becomes a lead).
// The owner can mute the alerts for himself only; managers always hear. Brokers never see it. The old address
// /app/portal-enquiries redirects to the tab; the forms still post here and come back to it.
"use strict";

const Authz = require("../../lib/authz");
const Enquiries = require("../../services/portalEnquiries");
const Phone = require("../../domain/phone");
const { html } = require("../html");

const { L } = require("../../lib/copy");
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const NOTICES = {
  saved: ["✅ اتحفظ.", "✅ Saved."],
  linked: ["✅ الاستفسار اتربط بالوحدة.", "✅ The enquiry is linked to the unit."],
  assigned: ["✅ اتحول لعميل.", "✅ Now a lead."],
  colleague: ["✅ الرقم ده لعميل عند زميل: اتسجل الاستفسار عنده ومفيش تفاصيل ظاهرة.", "✅ The phone belongs to a colleague's lead: the enquiry was noted there, no details shown."],
  merged: ["✅ الرقم كان لعميل موجود: اتضاف للعميل، والبروكر بتاعه لسه معاه.", "✅ The phone was already a lead: merged into it, and its broker stays."],
  repeat: ["ℹ️ الاستفسار ده اتسجل قبل كده (آخر يوم). مش هيتسجل تاني.", "ℹ️ This enquiry was already kept in the last day. It was not kept twice."],
  error: ["❌ حصلت مشكلة. اتأكد من البيانات وحاول تاني.", "❌ Something went wrong. Check the details and try again."]
};
const ERRORS = {
  no_rotation_broker: ["مفيش بروكر متاح للتوزيع بالدور دلوقتي.", "No broker is available for round-robin assignment."],
  not_enquiry: ["الرسالة دي مش رسالة استفسار من بوابة (Bayut أو Dubizzle أو Nawy).", "That is not a portal enquiry message (Bayut, Dubizzle or Nawy)."],
  phone_invalid: ["الرقم مش مظبوط.", "The phone number isn't valid."],
  already_assigned: ["الاستفسار ده اتحول قبل كده.", "This enquiry was already assigned."],
  erased_before: ["الرقم ده اتمسح قبل كده بطلب العميل.", "This number was erased at the client's request."],
  unit_not_found: ["الكود ده مش موجود عندك.", "No unit with that code."],
  already_linked: ["رقم الإعلان ده متربط بوحدة تانية.", "That listing number is already linked to another unit."],
  unit_changed: ["الوحدة اتعدلت وإنت بتربط. جرب تاني.", "The unit changed while you were linking. Try again."],
  no_listing_number: ["الرابط ده مفيهوش رقم إعلان.", "This link has no listing number."],
  assignee: ["البروكر ده مش متاح دلوقتي.", "That broker isn't available."],
  assignee_away: ["البروكر ده في إجازة.", "That broker is away."]
};

const when = (d, lang) => (d ? new Date(d).toLocaleString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", dateStyle: "short", timeStyle: "short" }) : "");

/** The paste box: the portal's message from WhatsApp; the phone and broker are optional here (they can be added in the list). */
function pasteBox(brokers, lang) {
  return html`<form method="post" action="/app/portal-enquiries/paste" class="card stack" data-portal-paste>
  <label for="portal-msg">${L(lang, "الزق رسالة البوابة هنا", "Paste the portal message here")}</label>
  <textarea id="portal-msg" name="message" rows="5" maxlength="4000" required placeholder="${L(lang, "الصق رسالة الاستفسار اللي جتلك على واتساب", "Paste the enquiry message you got on WhatsApp")}"></textarea>
  <input name="phone" dir="ltr" inputmode="tel" placeholder="${L(lang, "رقم العميل (اختياري)", "Client phone (optional)")}" aria-label="${L(lang, "الرقم", "Phone")}">
  <select name="broker_id" aria-label="${L(lang, "البروكر", "Broker")}">
    <option value="">${L(lang, "البروكر (اختياري)", "Broker (optional)")}</option>
    <option value="round_robin">${L(lang, "وزّع بالدور", "Assign by round robin")}</option>
    ${brokers.map((b) => html`<option value="${b.id}">${b.name}</option>`)}
  </select>
  <button type="submit">${L(lang, "اقرأ الرسالة", "Read message")}</button>
</form>`;
}

function enquiryRow(e, brokers, lang) {
  const linked = e.unit_code
    ? html`<strong>${e.unit_code}</strong>`
    : e.listing_no
      ? html`<form method="post" action="/app/portal-enquiries/${e.id}/link" class="inline"><input name="unit_code" dir="ltr" size="10" placeholder="NH-V12" aria-label="${L(lang, "كود الوحدة", "Unit code")}"><button type="submit">${L(lang, "ربط", "Link")}</button></form>`
      : html`<span class="muted">—</span>`;
  const action =
    e.status === "assigned"
      ? html`<span>${e.lead_ref ? e.lead_ref : ""} ${e.assignee_name || ""}${e.merged ? html` <span class="muted">(${L(lang, "اتضاف لعميل موجود", "merged into a lead")})</span>` : ""}</span>`
      : html`<form method="post" action="/app/portal-enquiries/${e.id}/assign" class="stack">
          <input name="phone" dir="ltr" inputmode="tel" placeholder="+20 1xx xxx xxxx" required aria-label="${L(lang, "الرقم", "Phone")}">
          <select name="broker_id" required aria-label="${L(lang, "البروكر", "Broker")}">
            <option value="">${L(lang, "اختار بروكر", "Choose a broker")}</option>
            <option value="round_robin">${L(lang, "وزّع بالدور", "Assign by round robin")}</option>
    ${brokers.map((b) => html`<option value="${b.id}">${b.name}</option>`)}
          </select>
          <button type="submit">${L(lang, "أضف وحوّل", "Add and assign")}</button>
        </form>`;
  return html`<tr data-enquiry="${e.id}"><td dir="ltr">${when(e.created_at, lang)}</td><td>${e.portal}</td><td>${e.client_name || "—"}</td>
    <td><a href="${e.link}" target="_blank" rel="noopener noreferrer">${L(lang, "الإعلان", "Listing")}</a> <span class="muted" dir="ltr">${e.listing_no || ""}</span></td>
    <td>${linked}</td><td>${action}</td></tr>`;
}

/** The tab's content (inside the Leads page): the intro, the owner's mute and the table. */
function enquiriesPanel({ rows, brokers, lang, owner, alertsOn, notice }) {
  return html`${notice || ""}
<p class="muted">${L(lang, "استفسارات Bayut وDubizzle وNawy. الاسم والرابط بس. لما تضيف الرقم وتحوّل للبروكر، الاستفسار بيبقى عميل.", "Enquiries from Bayut, Dubizzle and Nawy: name and link only. Add the phone and assign a broker, and it becomes a lead.")}</p>
${pasteBox(brokers, lang)}
${owner ? html`<form method="post" action="/app/portal-enquiries/alerts" class="card stack"><label><input type="checkbox" name="on" value="1" ${alertsOn ? "checked" : ""}> ${L(lang, "تنبيهات الاستفسارات ليا (إنت المالك بس)", "Enquiry alerts for me (the owner only)")}</label><button type="submit">${L(lang, "حفظ", "Save")}</button></form>` : ""}
${rows.length
  ? html`<div class="scroll card"><table><thead><tr><th>${L(lang, "التاريخ", "Date")}</th><th>${L(lang, "البوابة", "Portal")}</th><th>${L(lang, "الاسم", "Name")}</th><th>${L(lang, "الرابط", "Link")}</th><th>${L(lang, "الوحدة", "Unit")}</th><th>${L(lang, "الرقم والبروكر", "Phone and broker")}</th></tr></thead>
    <tbody>${rows.map((e) => enquiryRow(e, brokers, lang))}</tbody></table></div>`
  : html`<p class="card muted">${L(lang, "مفيش استفسارات لسه.", "No enquiries yet.")}</p>`}`;
}

/** Loads and renders the tab for a manager. */
async function panel(pool, actor, lang, extra = {}) {
  const [rows, brokers, me] = await Promise.all([
    Enquiries.list(pool, actor),
    pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name", [actor.agency_id]).then((r) => r.rows),
    pool.query("SELECT notify_prefs FROM brokers WHERE id = $1", [actor.id]).then((r) => r.rows[0] || {})
  ]);
  const alertsOn = !Enquiries.isMuted({ ...actor, notify_prefs: me.notify_prefs });
  return enquiriesPanel({ rows, brokers, lang, owner: Authz.isAgencyOwner(actor), alertsOn, ...extra });
}

/** The notice for ?done= / ?error= on the tab's address. */
function noticeFor(lang, query = {}) {
  const key = query.done;
  if (key && NOTICES[key]) return html`<p class="card notice ok" role="status">${L(lang, NOTICES[key][0], NOTICES[key][1])}</p>`;
  if (query.error) return html`<p class="card notice bad" role="alert">${L(lang, ERRORS[query.error]?.[0] || NOTICES.error[0], ERRORS[query.error]?.[1] || NOTICES.error[1])}</p>`;
  return "";
}

const TAB = "/app/leads?tab=portal";
const back = (qs) => `${TAB}&${qs}`;

const assignment = (brokerId) => brokerId === "round_robin" ? { roundRobin: true } : { brokerId };

function register(web, { pool }) {
  const managersOnly = (req, res) => {
    const lang = langOf(req);
    if (Authz.isManager(req.session.broker)) return true;
    res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    return false;
  };

  // The old address: the tab inside Leads.
  web.get("/portal-enquiries", (req, res) => {
    if (!managersOnly(req, res)) return undefined;
    const key = req.query.done;
    return res.redirect(303, key && NOTICES[key] ? back(`done=${encodeURIComponent(key)}`) : TAB);
  });

  // The paste box: keeps the message as an enquiry; with a phone and a broker it becomes a lead in the same step.
  web.post("/portal-enquiries/paste", async (req, res) => {
    if (!managersOnly(req, res)) return undefined;
    const actor = req.session.broker;
    const message = String(req.body.message || "").slice(0, 4000);
    const phone = String(req.body.phone || "").trim();
    const brokerId = String(req.body.broker_id || "").trim();
    if (phone && !Phone.toE164(phone)) return res.redirect(303, back("error=phone_invalid"));
    const cap = await Enquiries.capture(pool, actor, message);
    if (cap.outcome === "not_enquiry") return res.redirect(303, back("error=not_enquiry"));
    if (cap.outcome !== "created" && cap.outcome !== "repeat") return res.redirect(303, back("error=error"));
    if (phone && brokerId) {
      const r = await Enquiries.assign(pool, actor, cap.outcome === "repeat" ? cap.id : cap.enquiry.id, { phone, ...assignment(brokerId) });
      if (r.error) return res.redirect(303, back(`error=${encodeURIComponent(r.error)}`));
      return res.redirect(303, back(`done=${r.outcome === "created" ? "assigned" : r.outcome === "colleague" ? "colleague" : "merged"}`));
    }
    return res.redirect(303, back(cap.outcome === "repeat" ? "done=repeat" : "done=saved"));
  });

  web.post("/portal-enquiries/:id/assign", async (req, res) => {
    if (!managersOnly(req, res)) return undefined;
    const r = await Enquiries.assign(pool, req.session.broker, req.params.id, { phone: req.body.phone, ...assignment(req.body.broker_id) });
    if (r.error) return res.redirect(303, back(`error=${encodeURIComponent(r.error)}`));
    const done = r.outcome === "created" ? "assigned" : r.outcome === "colleague" ? "colleague" : "merged";
    return res.redirect(303, back(`done=${done}`));
  });

  web.post("/portal-enquiries/:id/link", async (req, res) => {
    if (!managersOnly(req, res)) return undefined;
    const r = await Enquiries.linkUnit(pool, req.session.broker, req.params.id, req.body.unit_code);
    if (r.error) return res.redirect(303, back(`error=${encodeURIComponent(r.error)}`));
    return res.redirect(303, back("done=linked"));
  });

  web.post("/portal-enquiries/alerts", async (req, res) => {
    const lang = langOf(req);
    const r = await Enquiries.setAlerts(pool, req.session.broker, req.body.on === "1");
    if (r.error) return res.status(403).type("text/plain").send(L(lang, "للمالك بس", "Owner only"));
    return res.redirect(303, back("done=saved"));
  });
}

module.exports = { register, panel, noticeFor };
