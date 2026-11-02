// web/routes/portalEnquiries.js — "Portal enquiries" (/app/portal-enquiries): managers and the owner. Each enquiry from
// Bayut, Dubizzle or Nawy: link to the unit (once per listing number), add the phone, assign a broker (becomes a lead).
// The owner can mute the alerts for himself only; managers always hear. Brokers never see this page.
"use strict";

const Authz = require("../../lib/authz");
const Enquiries = require("../../services/portalEnquiries");
const { html } = require("../html");

const L = (lang, ar, en) => (lang === "en" ? en : ar);
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const NOTICES = {
  saved: ["✅ اتحفظ.", "✅ Saved."],
  linked: ["✅ الاستفسار اتربط بالوحدة.", "✅ The enquiry is linked to the unit."],
  assigned: ["✅ اتحول لعميل.", "✅ Now a lead."],
  colleague: ["✅ الرقم ده لعميل عند زميل: اتسجل الاستفسار عنده ومفيش تفاصيل ظاهرة.", "✅ The phone belongs to a colleague's lead: the enquiry was noted there, no details shown."],
  merged: ["✅ الرقم كان لعميل موجود: اتضاف للعميل، والوسيط بتاعه لسه معاه.", "✅ The phone was already a lead: merged into it, and its broker stays."],
  error: ["❌ حصلت مشكلة. اتأكد من البيانات وحاول تاني.", "❌ Something went wrong. Check the details and try again."]
};
const ERRORS = {
  phone_invalid: ["الرقم مش مظبوط.", "The phone number isn't valid."],
  already_assigned: ["الاستفسار ده اتحول قبل كده.", "This enquiry was already assigned."],
  erased_before: ["الرقم ده اتمسح قبل كده بطلب العميل.", "This number was erased at the client's request."],
  unit_not_found: ["الكود ده مش موجود عندك.", "No unit with that code."],
  already_linked: ["رقم الإعلان ده متربط بوحدة تانية.", "That listing number is already linked to another unit."],
  unit_changed: ["الوحدة اتعدلت وإنت بتربط. جرب تاني.", "The unit changed while you were linking. Try again."],
  no_listing_number: ["الرابط ده مفيهوش رقم إعلان.", "This link has no listing number."],
  assignee: ["الوسيط ده مش متاح دلوقتي.", "That broker isn't available."],
  assignee_away: ["الوسيط ده في إجازة.", "That broker is away."]
};

const when = (d, lang) => (d ? new Date(d).toLocaleString(lang === "en" ? "en-GB" : "ar-EG", { timeZone: "Africa/Cairo", dateStyle: "short", timeStyle: "short" }) : "");

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
          <select name="broker_id" required aria-label="${L(lang, "الوسيط", "Broker")}">
            <option value="">${L(lang, "اختار وسيط", "Choose a broker")}</option>
            ${brokers.map((b) => html`<option value="${b.id}">${b.name}</option>`)}
          </select>
          <button type="submit">${L(lang, "أضف وحوّل", "Add and assign")}</button>
        </form>`;
  return html`<tr data-enquiry="${e.id}"><td dir="ltr">${when(e.created_at, lang)}</td><td>${e.portal}</td><td>${e.client_name || "—"}</td>
    <td><a href="${e.link}" target="_blank" rel="noopener noreferrer">${L(lang, "الإعلان", "Listing")}</a> <span class="muted" dir="ltr">${e.listing_no || ""}</span></td>
    <td>${linked}</td><td>${action}</td></tr>`;
}

function enquiriesPage({ rows, brokers, lang, owner, alertsOn, notice }) {
  return html`${notice || ""}
<h1>📩 ${L(lang, "استفسارات البوابات", "Portal enquiries")}</h1>
<p class="muted">${L(lang, "استفسارات Bayut وDubizzle وNawy. الاسم والرابط بس. لما تضيف الرقم وتحوّل للوسيط، الاستفسار بيبقى عميل.", "Enquiries from Bayut, Dubizzle and Nawy: name and link only. Add the phone and assign a broker, and it becomes a lead.")}</p>
${owner ? html`<form method="post" action="/app/portal-enquiries/alerts" class="card stack"><label><input type="checkbox" name="on" value="1" ${alertsOn ? "checked" : ""}> ${L(lang, "تنبيهات الاستفسارات ليا (إنت المالك بس)", "Enquiry alerts for me (the owner only)")}</label><button type="submit">${L(lang, "حفظ", "Save")}</button></form>` : ""}
${rows.length
  ? html`<div class="scroll card"><table><thead><tr><th>${L(lang, "التاريخ", "Date")}</th><th>${L(lang, "البوابة", "Portal")}</th><th>${L(lang, "الاسم", "Name")}</th><th>${L(lang, "الرابط", "Link")}</th><th>${L(lang, "الوحدة", "Unit")}</th><th>${L(lang, "الرقم والوسيط", "Phone and broker")}</th></tr></thead>
    <tbody>${rows.map((e) => enquiryRow(e, brokers, lang))}</tbody></table></div>`
  : html`<p class="card muted">${L(lang, "مفيش استفسارات لسه.", "No enquiries yet.")}</p>`}`;
}

function register(web, { pool, page }) {
  const render = async (req, res, extra = {}, status = 200) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!Authz.isManager(actor)) return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    const [rows, brokers, me] = await Promise.all([
      Enquiries.list(pool, actor),
      pool.query("SELECT id, name FROM brokers WHERE agency_id = $1 AND is_active ORDER BY name", [actor.agency_id]).then((r) => r.rows),
      pool.query("SELECT notify_prefs FROM brokers WHERE id = $1", [actor.id]).then((r) => r.rows[0] || {})
    ]);
    const alertsOn = !Enquiries.isMuted({ ...actor, notify_prefs: me.notify_prefs });
    const body = enquiriesPage({ rows, brokers, lang, owner: Authz.isAgencyOwner(actor), alertsOn, ...extra });
    return page(req, res, { title: L(lang, "استفسارات البوابات", "Portal enquiries"), body }, status);
  };
  const notice = (lang, key, ok = true) => html`<p class="card notice ${ok ? "ok" : "bad"}" role="status">${L(lang, NOTICES[key][0], NOTICES[key][1])}</p>`;
  const errNotice = (lang, code) => html`<p class="card notice bad" role="alert">${L(lang, ERRORS[code]?.[0] || NOTICES.error[0], ERRORS[code]?.[1] || NOTICES.error[1])}</p>`;

  web.get("/portal-enquiries", (req, res) => {
    const lang = langOf(req);
    const key = req.query.done;
    return render(req, res, key && NOTICES[key] ? { notice: notice(lang, key) } : {});
  });

  web.post("/portal-enquiries/:id/assign", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!Authz.isManager(actor)) return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    const r = await Enquiries.assign(pool, actor, req.params.id, { phone: req.body.phone, brokerId: req.body.broker_id });
    if (r.error) return render(req, res, { notice: errNotice(lang, r.error) }, 400);
    const done = r.outcome === "created" ? "assigned" : r.outcome === "colleague" ? "colleague" : "merged";
    return res.redirect(303, `/app/portal-enquiries?done=${done}`);
  });

  web.post("/portal-enquiries/:id/link", async (req, res) => {
    const lang = langOf(req);
    const actor = req.session.broker;
    if (!Authz.isManager(actor)) return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    const r = await Enquiries.linkUnit(pool, actor, req.params.id, req.body.unit_code);
    if (r.error) return render(req, res, { notice: errNotice(lang, r.error) }, 400);
    return res.redirect(303, "/app/portal-enquiries?done=linked");
  });

  web.post("/portal-enquiries/alerts", async (req, res) => {
    const lang = langOf(req);
    const r = await Enquiries.setAlerts(pool, req.session.broker, req.body.on === "1");
    if (r.error) return res.status(403).type("text/plain").send(L(lang, "للمالك بس", "Owner only"));
    return res.redirect(303, "/app/portal-enquiries?done=saved");
  });
}

module.exports = { register };
