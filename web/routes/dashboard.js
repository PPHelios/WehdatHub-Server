// web/routes/dashboard.js — The agency dashboard and leaderboard (7.2, managers: /app/dashboard) and the owner's tracking
// dashboard (5.4, OWNER_BROKER_IDS only: /app/owner; everyone else gets the ordinary 404). Numbers only: no client's name
// or phone appears on either page. Queries live in services/dashboards.js. The owner page also switches PDF and photo
// price-list reading on per agency with its monthly pages (Release B C5).
"use strict";

const Period = require("../../lib/period");

const PriceReading = require("../../services/priceReading");
const Credits = require("../../services/credits");
const Leases = require("../../services/leases");
const Targets = require("../../services/targets");
const Reading = require("../../domain/priceReading");
const AiUserLimits = require("../../services/aiUserLimits");
const ChatImportReport = require("../../services/chatImportReport");
const Dash = require("../../services/dashboards");
const Onboarding = require("../../services/onboarding");
const Quotas = require("../../services/quotas");
const { quotaSection } = require("../views/quotas");
const Stages = require("../../domain/leadStages");
const Commission = require("../../domain/commission");
const Billing = require("../../services/billing");
const BillingNotices = require("../../services/billingNotices");
const Signup = require("../../services/signup");
const { switchField, choiceField } = require("../views/switches");
const PlaceReview = require("../../services/placeReview");
const Referrals = require("../../services/referrals");
const Intake = require("../../services/leadIntake");
const Plans = require("../../domain/plans");
const Phone = require("../../domain/phone");
const { html } = require("../html");
const { tabs } = require("../views/tabs");
const { icon } = require("../icons");
const Privacy = require("../../services/unitPrivacy");
const Rights = require("../../services/unitRights");
const OwnerAgencies = require("../../services/ownerAgencies");
const Analytics = require("../../services/analytics");
const AnalyticsView = require("../views/analytics");
const AgencyCreate = require("../../services/agencyCreate");
const { isManager, isAgencyOwner } = require("../../lib/authz");
const { logOperation } = require("../../lib/db");
const Audit = require("../../services/audit");
const Vis = require("../../lib/visibility");

const { L } = require("../../lib/copy");
const langOf = (req) => (req.session.broker.preferred_lang === "en" ? "en" : "ar");
const money = (n, lang) => Commission.money(n, lang);
const minutes = (m, lang) => {
  if (m === null || m === undefined) return "—";
  if (m < 60) return L(lang, `${m} د`, `${m} min`);
  if (m < 48 * 60) return L(lang, `${Math.round(m / 60)} س`, `${Math.round(m / 60)} h`);
  return L(lang, `${Math.round(m / 1440)} يوم`, `${Math.round(m / 1440)} d`);
};
const medal = (i) => ["🥇", "🥈", "🥉"][i] || `${i + 1}`;
const notFound = (req, res, page) =>
  page(req, res, { title: L(langOf(req), "غير موجود", "Not found"), body: html`<div class="card"><h1>🔍 ${L(langOf(req), "الصفحة غير موجودة", "Page not found")}</h1><p><a class="btn secondary small" href="/app/">${L(langOf(req), "الرئيسية", "Home")}</a></p></div>` }, 404);

/** N6: this month's progress against each broker's target. */
function targetsSection(rows, lang) {
  const bar = (n, of) => (of ? html`<progress max="100" value="${Math.min(100, Targets.pct(n, of))}"></progress> ${Targets.pct(n, of)}%` : "—");
  return html`<section class="card" id="targets">
  <h2>🎯 ${L(lang, "أهداف الشهر", "This month's targets")}</h2>
  ${rows.length
    ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "البروكر", "Broker")}</th><th>${L(lang, "صفقات", "Deals")}</th><th></th><th>${L(lang, "العمولة", "Commission")}</th><th></th></tr></thead>
  <tbody>${rows.map((r) => html`<tr data-target="${r.id}"><td>${r.name}</td><td>${r.deals}${r.target_deals ? ` / ${r.target_deals}` : ""}</td><td>${bar(r.deals, r.target_deals)}</td><td>${money(r.commission, lang)}${r.target_commission ? html` / ${money(r.target_commission, lang)}` : ""}</td><td>${bar(r.commission, r.target_commission)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش أهداف. حط هدف لكل بروكر من صفحة الفريق.", "No targets yet. Set one per broker on the Team page.")} <a href="/app/team">${L(lang, "الفريق", "Team")}</a></p>`}
</section>`;
}

/** N4: rented units whose lease ends in the next 90 days. */
function leaseEnds(rows, lang) {
  return html`<section class="card" id="lease-ends">
  <h2>🔑 ${L(lang, "عقود إيجار بتخلص خلال 90 يوم", "Leases ending in the next 90 days")}</h2>
  ${rows.length
    ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الوحدة", "Unit")}</th><th>${L(lang, "بتخلص", "Ends")}</th><th>${L(lang, "المستأجر", "Tenant")}</th><th>${L(lang, "البروكر", "Broker")}</th><th>${L(lang, "الإيجار", "Rent")}</th></tr></thead>
  <tbody>${rows.map((r) => html`<tr data-lease-end="${r.code}"><td><a href="/app/units/${encodeURIComponent(r.code)}#lease">${r.code}</a></td><td dir="ltr">${r.end.toISOString().slice(0, 10)}</td><td>${r.tenant_name || "—"}</td><td>${r.broker_name || "—"}${r.remind ? " 🔔" : ""}</td><td>${r.rent ? money(r.rent, lang) : "—"}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش. سجّل عقد الإيجار من صفحة الوحدة المؤجرة.", "None. Enter a lease on the rented unit's page.")}</p>`}
</section>`;
}

function agencyPage(d, lang, { team = "", ai = "", settings = "", open = 0, unitWarning = "" } = {}) {
  const kpi = (label, value, attr) => html`<div class="kpi" data-kpi="${attr}"><span class="muted small">${label}</span><strong>${value}</strong></div>`;
  const q = d.brokerId ? `&broker=${d.brokerId}` : d.teamLeadId ? `&team=${d.teamLeadId}` : "";
  const todo = [
    ["uncontacted", d.uncontacted, L(lang, "عملاء جداد محدش كلمهم", "New leads nobody called"), "/app/leads?tab=new"],
    ["overdue", d.overdue, L(lang, "متابعات متأخرة", "Overdue follow-ups"), "/app/leads?tab=overdue"],
    ["unassigned", d.unassigned, L(lang, "عملاء من غير بروكر", "Leads with no broker"), "/app/leads?broker=none"],
    ["stale", d.units.stale, L(lang, "وحدات محتاجة تأكيد (21 يوم)", "Units to confirm (21 days)"), "/app/units"]
  ];
  const maxStage = Math.max(1, ...Object.values(d.pipeline));
  const maxWeek = Math.max(1, ...(d.weekly || []));
  return html`<h1>${L(lang, "لوحة الشركة", "Agency dashboard")}</h1>
${unitWarning}
<form method="get" action="/app/dashboard" class="stack" data-dash-filters>
  <nav class="seg" aria-label="${L(lang, "الفترة", "Period")}">${Dash.PERIODS.map(
    (p) => html`<a href="/app/dashboard?days=${p}${q}"${p === d.days ? html` aria-current="page"` : ""}>${L(lang, `${p} يوم`, `${p} days`)}</a>`
  )}</nav>
  <input type="hidden" name="days" value="${d.days}">
  <select name="broker" data-autosubmit aria-label="${L(lang, "البروكر", "Broker")}"><option value="">${L(lang, "كل الفريق", "Whole team")}</option>${d.team.map((b) => html`<option value="${b.id}"${b.id === d.brokerId ? html` selected` : ""}>${b.name}</option>`)}</select>
  ${d.teamLeads.length ? html`<select name="team" data-autosubmit aria-label="${L(lang, "فريق تيم ليد", "Team lead's team")}"><option value="">${L(lang, "كل الشركة", "Whole agency")}</option>${d.teamLeads.map((t) => html`<option value="${t.id}"${t.id === d.teamLeadId ? html` selected` : ""}>${L(lang, `فريق ${t.name}`, `${t.name}'s team`)}</option>`)}</select>` : ""}
  <noscript><button type="submit">${L(lang, "تطبيق", "Apply")}</button></noscript>
</form>
<div class="kpis">
  ${kpi(L(lang, "عملاء جداد", "New leads"), d.leads, "leads")}
  ${kpi(L(lang, "صفقات", "Deals"), d.deals.n, "deals")}
  ${kpi(L(lang, "العمولة", "Commission"), money(d.deals.commission, lang), "commission")}
  ${kpi(L(lang, "وحدات متاحة", "Active units"), d.units.active, "units")}
</div>
${tabs("dash_tab", [
  [L(lang, "العملاء", "Leads"), html`${todo.some(([, n]) => n)
  ? html`<section class="card list" id="needs-action"><h2>${L(lang, "محتاج تتصرف", "Needs action")}</h2><ul class="rows">${todo.filter(([, n]) => n).map(
      ([k, n, label, href]) => html`<li data-kpi="${k}"><a class="listrow" href="${href}">${label}<b class="chip late">${n}</b></a></li>`
    )}</ul></section>`
  : html`<p class="card notice ok" id="needs-action">${L(lang, "مفيش حاجة متأخرة. شغل نضيف.", "Nothing late. Clean work.")}</p>`}
${d.weekly && d.weekly.some(Boolean)
  ? html`<section class="card" id="weekly"><h2>${L(lang, "عملاء جداد كل أسبوع", "New leads per week")}</h2>
  <ol class="bars" aria-label="${L(lang, "آخر 8 أسابيع", "Last 8 weeks")}">${d.weekly.map((n, i) => html`<li title="${n}"><span class="bar" data-h="${Math.round((n * 10) / maxWeek)}"></span><span class="small">${n}</span><span class="muted small">${i === 7 ? L(lang, "ده", "now") : `-${7 - i}`}</span></li>`)}</ol>
</section>`
  : ""}
<section class="card" id="funnel">
  <h2>${L(lang, "المراحل دلوقتي", "Pipeline now")}</h2>
  <ul class="funnel">${Stages.STAGES.map((s) => html`<li data-stage="${s}"><a href="/app/leads?tab=${s}">${Stages.stageLabel(s, lang)}</a><progress max="${maxStage}" value="${d.pipeline[s]}"></progress><b>${d.pipeline[s]}</b></li>`)}</ul>
</section>
${d.sources && d.sources.length
  ? html`<section class="card" id="top-sources"><h2>${L(lang, "أكتر مصادر العملاء", "Top lead sources")}</h2>
  <ul class="rows">${d.sources.map((x) => html`<li class="listrow">${x.source === "-" ? L(lang, "من غير مصدر", "No source") : Stages.sourceLabel(x.source, lang)}<b>${x.n}</b></li>`)}</ul>
  <p class="row"><a class="btn secondary small" href="/app/sources">${L(lang, "المصادر وتكلفة الإعلانات", "Sources and ad cost")}</a> <a class="btn secondary small" href="/app/winloss">${L(lang, "المكسب والخسارة", "Win and loss")}</a></p>
</section>`
  : html`<p class="row"><a class="btn secondary small" href="/app/sources">${L(lang, "المصادر وتكلفة الإعلانات", "Sources and ad cost")}</a> <a class="btn secondary small" href="/app/winloss">${L(lang, "المكسب والخسارة", "Win and loss")}</a></p>`}
`],
  [L(lang, "الفريق", "Team"), html`<section class="card" id="leaderboard">
  <h2>${L(lang, `ترتيب البروكرز (آخر ${d.days} يوم)`, `Leaderboard (last ${d.days} days)`)}</h2>
  ${d.board.length
    ? html`<ol class="board">${d.board.map(
        (b, i) => html`<li data-broker="${b.id}"><details><summary><span class="medal">${medal(i)}</span><strong>${b.name}</strong><span class="muted small">${L(lang, `${b.deals} صفقة`, `${b.deals} deal(s)`)} · ${money(b.commission, lang)}</span></summary>
  <dl class="bfacts">
    <div><dt>${L(lang, "عملاء جداد", "New leads")}</dt><dd>${b.leads}</dd></div>
    <div><dt>${L(lang, "مكالمات", "Contacted")}</dt><dd>${b.contacted}</dd></div>
    <div><dt>${L(lang, "تحريك للأمام", "Moved forward")}</dt><dd>${b.forward}</dd></div>
    <div><dt>${L(lang, "معاينات", "Viewings")}</dt><dd>${b.viewings}</dd></div>
    <div><dt>${L(lang, "وحدات أضافها", "Units added")}</dt><dd>${b.units}</dd></div>
    <div><dt>${L(lang, "وقت الرد", "Response time")}</dt><dd>${minutes(b.responseMin, lang)}</dd></div>
    <div><dt>${L(lang, "عملاء مفتوحين", "Open leads")}</dt><dd>${b.open}</dd></div>
  </dl></details></li>`
      )}</ol>
  <p class="muted small">${L(lang, "الترتيب: الصفقات، بعدين العمولة، بعدين التحريك للأمام. وقت الرد = البروكر من وصول العميل لأول مكالمة.", "Ranked by deals, then commission, then moves forward. Response time = median from a lead arriving to its first contact.")}</p>`
    : html`<p class="muted">${L(lang, "مفيش نشاط في الفترة دي.", "No activity in this period.")}</p>`}
</section>${team}`],
  [L(lang, "الذكاء الاصطناعي", "AI use"), html`${ai}`],
  [L(lang, "الإعدادات", "Settings"), html`${settings}`]
], { open })}`;
}

/** Data security for managers: who sees private unit details, and the Excel export of every unit. */
function privacySection(scope, lang, csrf, notice, canSwitch = false, ret = null) {
  return html`<section class="card stack" id="data-security">
  <h2>${L(lang, "أمان البيانات", "Data security")}</h2>
  ${notice === "saved" ? html`<p class="notice ok">${L(lang, "✅ اتحفظ.", "✅ Saved.")}</p>` : ""}
  <form method="post" action="/app/dashboard/secret-details" class="stack"><input type="hidden" name="_csrf" value="${csrf}">${ret ? html`<input type="hidden" name="return" value="${ret}">` : ""}
    ${choiceField({ name: "scope", value: scope, disabled: !canSwitch, legend: L(lang, "مين يشوف المالك والعمولة ورقم الوحدة والعنوان واللوكيشن؟", "Who sees the owner, commission, unit number, address and pin?"), options: [{ value: "restricted", label: L(lang, "صاحب الوحدة والمديرين", "The unit's broker and managers") }, { value: "all", label: L(lang, "كل البروكرز في الشركة", "Every broker in the agency") }] })}
    <p class="muted small">${L(lang, "لو مقفولة، أي بروكر تاني يقدر يطلب يشوفها، وصاحب الوحدة أو مدير يوافق. كل طلب ورد بيتسجل.", "When closed, another broker can ask; the unit's broker or a manager answers. Every ask and answer is logged.")}</p>
    ${canSwitch ? html`<button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>` : html`<p class="muted small">${L(lang, "مالك الشركة بس يغيّر ده.", "Only the agency owner changes this.")}</p>`}
  </form>
  <p><a class="btn secondary" href="/app/units-export.xlsx" download>${icon("import", 18)} ${L(lang, "نزّل كل الوحدات (إكسيل)", "Download all units (Excel)")}</a> <span class="muted small">${L(lang, "للمديرين بس، وكل تنزيل بيتسجل.", "Managers only; every download is logged.")}</span></p>
</section>`;
}

/** The agency owner's switch for brokers adding and editing units (on by default; managers and data entry are never limited). */
function brokerEditSection(allowed, lang, csrf, canSwitch, ret = null) {
  return html`<section class="card stack" id="broker-edit">
  <h2>${L(lang, "إضافة وتعديل الوحدات للبروكرز", "Brokers adding and editing units")}</h2>
  <form method="post" action="/app/dashboard/brokers-edit-units" class="stack"><input type="hidden" name="_csrf" value="${csrf}">${ret ? html`<input type="hidden" name="return" value="${ret}">` : ""}
    ${switchField({ name: "allowed", on: allowed, disabled: !canSwitch, lang, label: L(lang, "البروكرز يقدروا يضيفوا ويعدّلوا وحدات", "Brokers may add and edit units"), sentence: L(lang, "البروكرز ومسؤولو الفرق يقدروا يضيفوا ويعدّلوا الوحدات. اقفلها عشان تبقى للقراءة بس عندهم. المديرين وإدخال البيانات مش متأثرين.", "Brokers and team leads can add and edit units. Turn off to make units read-only for them. Managers and data entry are not affected.") })}
    ${canSwitch ? html`<button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>` : html`<p class="muted small">${L(lang, "مالك الشركة بس يغيّر ده.", "Only the agency owner changes this.")}</p>`}
  </form>
</section>`;
}

/** The agency owner's switch for what brokers see of the agency's leads (on by default: all leads, read only). */
function leadScopeSection(seeAll, lang, csrf, canSwitch, ret = null) {
  return html`<section class="card stack" id="lead-scope">
  <h2>${L(lang, "العملاء قدّام البروكرز", "Leads brokers can see")}</h2>
  <form method="post" action="/app/dashboard/brokers-see-all-leads" class="stack"><input type="hidden" name="_csrf" value="${csrf}">${ret ? html`<input type="hidden" name="return" value="${ret}">` : ""}
    ${switchField({ name: "allowed", on: seeAll, disabled: !canSwitch, lang, label: L(lang, "البروكرز يشوفوا كل عملاء الشركة", "Brokers see all of the agency's leads"), sentence: L(lang, "شغّالة: البروكر يشوف كل العملاء (قراءة بس) ويشتغل على عملائه بس. اقفلها عشان كل بروكر يشوف عملائه بس. المديرين دايماً بيشوفوا الكل.", "On: a broker sees every lead (read only) and works only their own. Turn off so each broker sees only their own leads. Managers always see all.") })}
    ${canSwitch ? html`<button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>` : html`<p class="muted small">${L(lang, "مالك الشركة بس يغيّر ده.", "Only the agency owner changes this.")}</p>`}
  </form>
</section>`;
}

/** Owner controls (phase 2 step 4): the sign-up switch and waiting sign-ups, where agencies pay, payments to confirm. */
/** CRM owner only: add an agency by hand (name, logo URL, owner's mobile, plan). The owner's start link is shown once. */
function newAgencySection(lang, csrf) {
  return html`<section class="card" id="new-agency">
  <h2>➕ ${L(lang, "شركة جديدة", "New agency")}</h2>
  <p class="muted">${L(lang, "اكتب بيانات الشركة ورقم مالكها. هتطلع لينك تيليجرام واحد للمالك (صالح ٧ أيام)، ابعته له بنفسك.", "Enter the agency and its owner's mobile. You get one Telegram link for the owner (valid 7 days); send it yourself.")}</p>
  <form method="post" action="/app/owner/agencies" class="stack" data-new-agency>
    <input type="hidden" name="_csrf" value="${csrf}">
    <label>${L(lang, "اسم الشركة", "Agency name")} <input name="agency" required maxlength="120"></label>
    <label>${L(lang, "لينك اللوجو (https، اختياري)", "Logo link (https, optional)")} <input name="logo" type="url" dir="ltr" maxlength="500" placeholder="https://"></label>
    <label>${L(lang, "اسم المالك", "Owner's name")} <input name="ownerName" required maxlength="80"></label>
    <label>${L(lang, "موبايل المالك", "Owner's mobile")} <input name="ownerPhone" required inputmode="tel" dir="ltr" placeholder="01xxxxxxxxx" maxlength="20"></label>
    <fieldset class="row"><legend>${L(lang, "الباقة", "Plan")}</legend>
      <label><input type="radio" name="plan" value="pilot" checked> ${L(lang, "تجريبي مجاني (Office لحد ما الـPOC يخلص)", "Pilot (free Office until the POC ends)")}</label>
      <label><input type="radio" name="plan" value="pilot14"> ${L(lang, `تجريبي موجّه ${AgencyCreate.PILOT_DAYS} يوم (Office متعدد المستخدمين)`, `Guided ${AgencyCreate.PILOT_DAYS}-day pilot (Office, multi-seat)`)}</label>
      <label><input type="radio" name="plan" value="trial"> ${L(lang, `تجربة ${Plans.TRIAL.days} يوم`, `${Plans.TRIAL.days}-day trial`)}</label>
    </fieldset>
    <button type="submit">${L(lang, "اعمل الشركة وطلّع اللينك", "Create agency and get the link")}</button>
  </form>
</section>
`;
}

function billingSections(b, lang) {
  const day = (x) => new Date(x).toISOString().slice(0, 10);
  return html`${b.csrf !== undefined ? newAgencySection(lang, b.csrf) : ""}<section class="card" id="signups">
  <h2>🏢 ${L(lang, "التسجيل", "Sign-up")}</h2>
  <form method="post" action="/app/owner/signup" class="stack" data-signup-form>
    ${switchField({ name: "open", value: "1", on: b.open, lang, id: "signup-switch", label: L(lang, "التسجيل مفتوح", "Sign-up is open"), sentence: L(lang, "لما يكون شغّال، أي شركة تقدر تطلب تسجيل وكل طلب بيستنى موافقتك. لما يتقفل، مفيش طلبات جديدة.", "When on, any agency can ask to sign up and every request waits for your approval. When off, no new requests come in.") })}
    <button type="submit" class="secondary" data-signup-toggle="save">${L(lang, "حفظ", "Save")}</button>
  </form>
  ${b.signups.length
    ? html`<table><tbody>${b.signups.map(
        (s) => html`<tr data-signup="${s.id}"><td>${s.name}</td><td>${s.broker_name || "—"}</td><td dir="ltr">${s.phone_number ? `+${s.phone_number}` : "—"}</td><td dir="ltr">${day(s.signed_up_at)}</td>
  <td class="row"><form method="post" action="/app/owner/signups/${s.id}/approve"><button type="submit">✅ ${L(lang, "وافق", "Approve")}</button></form>
  <form method="post" action="/app/owner/signups/${s.id}/reject" data-confirm="${L(lang, "ترفض الطلب ده؟", "Reject this request?")}"><button type="submit" class="secondary">✖ ${L(lang, "ارفض", "Reject")}</button></form></td></tr>`
      )}</tbody></table>`
    : html`<p class="muted">${L(lang, "مفيش طلبات مستنية.", "No requests waiting.")}</p>`}
</section>
<section class="card" id="trial-agencies">
  <h2>⏳ ${L(lang, "شركات في التجربة", "Agencies on a trial")}</h2>
  ${b.trials.length
    ? html`<div class="scroll"><table><tbody>${b.trials.map(
        (t) => html`<tr data-trial-agency="${t.id}"><td>${t.name}</td><td>${new Date(t.trial_ends_at) > new Date() ? L(lang, "تنتهي", "Ends") : L(lang, "انتهت", "Ended")} <span dir="ltr">${day(t.trial_ends_at)}</span></td>
  <td class="row">${Billing.EXTEND_DAYS.map((n) => html`<form method="post" action="/app/owner/trials/${t.id}/extend"><input type="hidden" name="days" value="${n}"><button type="submit" class="secondary">+${n} ${L(lang, "يوم", "days")}</button></form>`)}</td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش.", "None.")}</p>`}
</section>
<section class="card" id="grace-agencies">
  <h2>🕓 ${L(lang, "شركات انتهت باقتها (سماح / قراءة فقط / متوقفة)", "Agencies whose paid plan ended (grace / read-only / stopped)")}</h2>
  ${(b.lapsed || []).length
    ? html`<div class="scroll"><table><tbody>${b.lapsed.map(
        (t) => html`<tr data-grace-agency="${t.id}" data-phase="${t.phase}"><td>${t.name}</td><td>${{ grace: L(lang, "سماح", "Grace"), readonly: L(lang, "قراءة فقط", "Read-only"), blocked: L(lang, "متوقفة", "Stopped") }[t.phase]} <span dir="ltr" class="muted">${day(t.end)} → ${day(t.graceEnd)} → ${day(t.readonlyEnd)}</span></td>
  <td class="row">${Billing.GRACE_EXTEND_DAYS.map((n) => html`<form method="post" action="/app/owner/grace/${t.id}/extend"><input type="hidden" name="days" value="${n}"><button type="submit" class="secondary">+${n} ${L(lang, "يوم سماح", "grace days")}</button></form>`)}</td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش.", "None.")}</p>`}
</section>
<section class="card" id="payments">
  <h2>💳 ${L(lang, "مدفوعات مستنية التأكيد", "Payments to confirm")}</h2>
  ${b.payments.length
    ? html`<div class="scroll"><table><tbody>${b.payments.map(
        (p) => html`<tr data-payment="${p.reference}"><td dir="ltr">${p.reference}</td><td>${p.agency_name}</td><td>${p.kind === "credit_bundle" ? L(lang, `رصيد زيادة ${Plans.bundleById(p.bundle_id)?.credits ?? ""}`, `Extra credits ${Plans.bundleById(p.bundle_id)?.credits ?? ""}`) : p.kind === "voice_pack" ? L(lang, "باقة فويس", "Voice pack") : p.kind === "upgrade" ? L(lang, `ترقية لـ ${Plans.planName(Plans.planById(p.plan), lang)}`, `Upgrade to ${Plans.planName(Plans.planById(p.plan), lang)}`) : `${Plans.planName(Plans.planById(p.plan), lang)} × ${p.months}`}</td><td>${p.amount_egp} ${L(lang, "ج.م", "EGP")}</td><td dir="ltr">${day(p.created_at)}</td>
  <td class="row"><form method="post" action="/app/owner/payments/${p.id}/confirm" data-confirm="${L(lang, `وصلك ${p.amount_egp} ج.م بالمرجع ${p.reference}؟`, `Did ${p.amount_egp} EGP with reference ${p.reference} arrive?`)}"><button type="submit">✅ ${L(lang, "وصل", "Received")}</button></form>
  <form method="post" action="/app/owner/payments/${p.id}/cancel" data-confirm="${L(lang, `تلغي الدفعة ${p.reference}؟ مش هينفع ترجع.`, `Cancel payment ${p.reference}? This can't be undone.`)}"><button type="submit" class="secondary">✖ ${L(lang, "الغِ", "Cancel")}</button></form></td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش.", "None.")}</p>`}
  <form method="post" action="/app/owner/pay-to" class="stack">
    <h3>${L(lang, "الشركات تدفع فين", "Where agencies pay")}</h3>
    <label>InstaPay <input name="instapay" maxlength="120" dir="ltr" placeholder="name@instapay" value="${b.payTo.instapay}"></label>
    <label>${L(lang, "تحويل بنكي (اختياري)", "Bank transfer (optional)")} <textarea name="bank" maxlength="300" rows="2">${b.payTo.bank}</textarea></label>
    <button type="submit" class="secondary">${L(lang, "احفظ", "Save")}</button>
  </form>
</section>`;
}

/** C5: PDF and photo price-list reading, off per agency until switched on here, with its monthly pages. */
function readingSection(rows, lang) {
  return html`<section class="card" id="price-reading">
  <h2>🤖 ${L(lang, "قراية قوايم الأسعار PDF والصور", "Reading PDF and photo price lists")}</h2>
  <p class="muted">${L(lang, "مقفولة لكل شركة لحد ما تفتحها هنا. الصفحة اللي اتقرت قبل كده (من أي شركة) بتتعاد من غير ما نقراها تاني، والشركة بتدفع رصيدها عادي. الشركات مش شايفة ده.", "Off for every agency until you switch it on here. A page read before (by any agency) is reused without a new AI call, and the agency is charged as usual. Agencies don't see this.")}</p>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الشركة", "Agency")}</th><th>${L(lang, "الشهر الحالي", "This month")}</th><th></th></tr></thead>
  <tbody>${rows.map(
    (a) => html`<tr data-reading="${a.id}"><td>${a.name}</td><td>${a.used} ${L(lang, "صفحة", "pages")}${a.reused ? html` <span class="muted">(+${a.reused} ${L(lang, "متعادة", "reused")})</span>` : ""}</td>
    <td><form method="post" action="/app/owner/price-reading/${a.id}" class="row">
      ${switchField({ name: "enabled", on: a.enabled, lang, label: L(lang, "مفعّلة", "On") })}
      <button type="submit" class="secondary">${L(lang, "احفظ", "Save")}</button>
    </form></td></tr>`
  )}</tbody></table></div>
</section>`;
}

/** Red banner while a Facebook intake is disconnected (owner dashboard and the agency's sources page use the same idea). */
function intakeBanner(rows, lang) {
  const down = rows.filter((r) => r.status === "disconnected" && !r.revoked_at);
  if (!down.length) return "";
  return html`<p class="card notice bad" role="alert" data-intake-banner>🔌 ${L(lang, `${down.length} ربط فيسبوك واقف: العملاء الجداد مش بيوصلوا. افتح تاب «ليدز فيسبوك» وحدّث التوكن.`, `${down.length} Facebook connection(s) stopped: new leads are not arriving. Open the "Facebook leads" tab and update the token.`)}</p>`;
}

/** L1/L2: the owner's Facebook leads tab: totals, one row per connected Page (health, counts, Test and Update token), the newest log rows and the connect form. */
function intakeSection(t, lang, { baseUrl = "" } = {}) {
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
  const time = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "—");
  const { rows, summary, agencies, log } = t;
  const why = (r) => (Intake.REASONS[r] || Intake.REASONS.token_invalid)[lang === "en" ? 1 : 0];
  const OUT = { created: ["عميل جديد", "New lead"], merged: ["اتضاف لعميل", "Merged"], colleague: ["مع زميل", "Colleague"], repeat: ["مكرر", "Repeat"], erased_before: ["اتمسح قبل كده", "Erased before"], invalid: ["رقم غلط", "Invalid"], test: ["تجربة", "Test"], error: ["خطأ", "Error"] };
  return html`<section class="card" id="lead-intake">
  <h2>📨 ${L(lang, "ليدز فيسبوك (أوتوماتيك)", "Facebook leads (automatic)")}</h2>
  <p class="muted">${L(lang, "كل شركة بتربط صفحتها هنا بالـ Page ID وتوكن الصفحة. أي عميل يملا فورم الإعلان بيوصل لوحده، ياخد المصدر، وبيروح للبروكر اللي عليه الدور. التوكن بيتحفظ مشفّر ومش بيظهر تاني.", "Connect an agency's Facebook Page here with its Page ID and Page access token. Every lead-ad form fill arrives by itself, gets the source and goes to the next broker in turn. The token is kept encrypted and never shown again.")}</p>
  <div class="grid" data-intake-summary>
    <div class="card" data-figure><span class="muted">${L(lang, "شغالة", "Active")}</span><strong>${summary.active}</strong></div>
    <div class="card" data-figure><span class="muted">${L(lang, "واقفة", "Disconnected")}</span><strong${summary.disconnected ? html` class="bad"` : ""}>${summary.disconnected}</strong></div>
    <div class="card" data-figure><span class="muted">${L(lang, "عملاء (30 يوم)", "Leads (30 days)")}</span><strong>${summary.leads30}</strong></div>
    <div class="card" data-figure><span class="muted">${L(lang, "فشل (30 يوم)", "Failed (30 days)")}</span><strong>${summary.failed30}</strong></div>
    <div class="card" data-figure><span class="muted">${L(lang, "طلبات لفيسبوك (30 يوم، تقريبي)", "Facebook calls (30 days, estimate)")}</span><strong>${summary.graphCalls30}</strong></div>
  </div>
  ${rows.length
    ? html`<div class="scroll"><table>
  <thead><tr><th>${L(lang, "الشركة", "Agency")}</th><th>${L(lang, "الصفحة", "Page")}</th><th>${L(lang, "الحالة", "Status")}</th><th>${L(lang, "آخر عميل", "Last lead")}</th><th>${L(lang, "24س / 7 أيام / 30 يوم", "24h / 7d / 30d")}</th><th>${L(lang, "فشل 30 يوم", "Failed 30d")}</th><th>${L(lang, "مكرر", "Repeats")}</th><th>${L(lang, "آخر خطأ", "Last error")}</th><th>${L(lang, "التوكن", "Token")}</th><th></th></tr></thead>
  <tbody>${rows.map(
    (i) => html`<tr data-intake="${i.id}"${i.status === "disconnected" ? html` class="bad"` : ""}><td>${i.agency_name}</td><td>${i.page_name || i.name} <span class="muted" dir="ltr">${i.page_id || ""}</span><br><span class="muted">${i.source}</span></td>
      <td>${i.status === "disconnected"
        ? html`<span class="bad" data-status="disconnected">🔴 ${L(lang, "واقفة", "Disconnected")}</span><br><span class="small">${why(i.disconnect_reason)}</span><br><span class="muted small" dir="ltr">${time(i.disconnected_at)}</span>`
        : html`<span data-status="active">🟢 ${L(lang, "شغالة", "Active")}</span>`}<br><span class="muted small">${i.subscribed_at ? `✅ ${L(lang, "مشتركة", "Subscribed")} ${day(i.subscribed_at)}` : L(lang, "مش مشتركة", "Not subscribed")}</span></td>
      <td dir="ltr">${time(i.last_lead_at)}</td><td dir="ltr">${i.leads_24h} / ${i.leads_7d} / ${i.leads_30d}</td>
      <td>${i.failed_30d ? html`<span class="bad">${i.failed_30d}</span>` : "0"}</td><td>${i.repeats_30d}</td>
      <td dir="ltr">${i.last_error_code ? html`${i.last_error_code}<br><span class="muted small">${time(i.last_error_at)}</span>` : "—"}</td><td dir="ltr">${i.token_hint ? html`…${i.token_hint}` : "—"}</td>
      <td><div class="stack">
        <form method="post" action="/app/owner/intake/${i.id}/test"><button type="submit" class="secondary">🧪 ${L(lang, "تجربة", "Test")}</button></form>
        <form method="post" action="/app/owner/intake/${i.id}/token" class="row" autocomplete="off"><input name="page_token" type="password" required autocomplete="off" dir="ltr" placeholder="${L(lang, "توكن جديد", "New token")}" aria-label="${L(lang, "توكن جديد", "New token")}"><button type="submit" class="secondary">🔑 ${L(lang, "حدّث التوكن", "Update token")}</button></form>
        <form method="post" action="/app/owner/intake/${i.id}/revoke" data-confirm="${L(lang, "الربط هيقف والتوكن هيتمسح. متأكد؟", "The connection will stop and the token will be deleted. Sure?")}"><button type="submit" class="secondary">⛔ ${L(lang, "وقّف", "Revoke")}</button></form>
      </div></td></tr>`
  )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش صفحات مربوطة لسه.", "No Pages connected yet.")}</p>`}
  ${log.length
    ? html`<h3>${L(lang, "آخر 20 طلب", "Latest 20 requests")}</h3><div class="scroll"><table>
  <thead><tr><th>${L(lang, "الوقت", "Time")}</th><th>${L(lang, "الشركة", "Agency")}</th><th>${L(lang, "المصدر", "Source")}</th><th>${L(lang, "النتيجة", "Result")}</th><th>${L(lang, "تفاصيل", "Detail")}</th></tr></thead>
  <tbody>${log.map((g) => html`<tr data-intake-log="${g.id}"><td dir="ltr">${time(g.received_at)}</td><td>${g.agency_name}</td><td>${g.intake_name}</td><td>${(OUT[g.outcome] || [g.outcome, g.outcome])[lang === "en" ? 1 : 0]}</td><td dir="ltr">${g.phone_tail ? `…${g.phone_tail} ` : ""}${g.detail || ""}</td></tr>`)}</tbody></table></div>`
    : ""}
  <details><summary>${L(lang, "خطوات الربط", "Setup steps")}</summary><ol>
    <li>${L(lang, "الشركة تدّيك صلاحية العملاء (Leads) على صفحتها في فيسبوك.", "The agency gives you Leads access on its Facebook Page.")}</li>
    <li>${L(lang, "اعمل توكن صفحة طويل المدة بالصلاحيات: pages_show_list, pages_manage_metadata, leads_retrieval, pages_read_engagement.", "Create a long-lived Page access token with: pages_show_list, pages_manage_metadata, leads_retrieval, pages_read_engagement.")}</li>
    <li>${L(lang, "مرة واحدة بس في تطبيق Meta: Webhooks ← Page ← Callback URL:", "Once in the Meta app: Webhooks → Page → Callback URL:")} <code dir="ltr">${baseUrl}/webhook/leadgen</code>, ${L(lang, "و Verify token = قيمة WHATSAPP_VERIFY_TOKEN، واشترك في الحقل", "Verify token = the WHATSAPP_VERIFY_TOKEN value, and subscribe to the field")} <code dir="ltr">leadgen</code>.</li>
    <li>${L(lang, "املا الفورم تحت (Page ID + التوكن) واضغط ربط. التطبيق بيتأكد من التوكن ويشترك في الصفحة لوحده.", "Fill the form below (Page ID + token) and press Connect. The app checks the token and subscribes the Page by itself.")}</li>
    <li>${L(lang, "دوس 🧪 تجربة، وبعدها ابعت عميل تجربة من Meta Lead Ads Testing Tool واتأكد إنه وصل لبروكر. (صفحات برّه شركتك محتاجة Advanced access / App Review.)", "Press 🧪 Test, then send a test lead from Meta's Lead Ads Testing Tool and check it reaches a broker. (Pages outside your own business need Advanced access / App Review.)")}</li>
    <li>${L(lang, "لو الربط وقف (باسورد اتغير، حد اتشال من الصفحة): هات توكن جديد من الشركة واضغط 🔑 حدّث التوكن.", "If a connection stops (password changed, someone removed from the Page): get a new token from the agency and press 🔑 Update token.")}</li>
  </ol></details>
  <form method="post" action="/app/owner/intake" class="row" autocomplete="off">
    <label>${L(lang, "الشركة", "Agency")} <select name="agency" required>${agencies.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
    <label>${L(lang, "الاسم", "Name")} <input name="name" required maxlength="60" value="Facebook ads"></label>
    <label>${L(lang, "المصدر", "Source")} <input name="source" required maxlength="60" value="Facebook"></label>
    <label>Page ID <input name="page_id" required inputmode="numeric" pattern="[0-9]{5,30}" dir="ltr"></label>
    <label>${L(lang, "توكن الصفحة (Page access token)", "Page access token")} <input name="page_token" type="password" required autocomplete="off" dir="ltr"></label>
    <label>${L(lang, "تنبيه لو مفيش عملاء (أيام)", "Alert after quiet days")} <input name="quiet_days" type="number" min="1" max="60" value="3" size="3"></label>
    <button type="submit">➕ ${L(lang, "ربط الصفحة", "Connect Page")}</button>
  </form>
</section>`;
}

/** Owner: agency referrals (Release B N9) — who invited whom and whether the free months were given; link an agency. */
function referralsSection(r, lang) {
  const day = (x) => new Date(x).toISOString().slice(0, 10);
  return html`<section class="card" id="referrals">
  <h2>🎁 ${L(lang, "الدعوات بين الشركات", "Agency referrals")}</h2>
  ${r.referrals.length
    ? html`<div class="scroll"><table><tbody>${r.referrals.map(
        (x) => html`<tr data-referral-row="${x.id}"><td>${x.name}</td><td>${L(lang, "←", "→")} ${x.referrer_name}</td><td>${x.referral_rewarded_at ? html`🎁 ${L(lang, "الشهرين اتحسبوا", "Both months given")} <span dir="ltr">${day(x.referral_rewarded_at)}</span>` : L(lang, "مستنية أول دفعة", "Waiting for its first payment")}</td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش دعوات لسه.", "No referrals yet.")}</p>`}
  ${r.linkable.length
    ? html`<form method="post" action="/app/owner/referrals" class="row">
    <label>${L(lang, "الشركة", "Agency")} <select name="agency">${r.linkable.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
    <label>${L(lang, "كود الشركة اللي دعتها", "Inviting agency's code")} <input name="code" required maxlength="12" dir="ltr"></label>
    <button type="submit" class="secondary">${L(lang, "اربط", "Link")}</button>
  </form>`
    : ""}
  <p class="muted">${L(lang, "الشركة اللي اتدعت وتدفع أول باقة تاخد شهر زيادة، واللي دعتها تاخد شهر (على باقتها لو بتدفع، أو رصيد لأول دفعة جاية).", "An invited agency gets an extra month on its first plan payment, and its inviter gets one (on its paid plan, or as a credit for its next payment).")}</p>
</section>`;
}

const STUCK = {
  nothing_added: ["مضافش وحدة ولا عميل", "no unit or lead yet"],
  no_telegram: ["مربطش تيليجرام", "Telegram not linked"],
  quiet: ["مختفي من 7 أيام+", "quiet 7+ days"]
};

/** Onboarding: brokers who joined 2+ days ago and are stuck, with a WhatsApp link to reach them. */
function stuckSection(stuck, lang) {
  const day = (t) => (t ? new Date(t).toISOString().slice(0, 10) : "—");
  return html`<section class="card" id="stuck">
  <h2>🧭 ${L(lang, `بروكرز محتاجين مساعدة (${stuck.length})`, `Brokers who need a hand (${stuck.length})`)}</h2>
  ${stuck.length
    ? html`<div class="scroll"><table>
  <thead><tr><th>${L(lang, "البروكر", "Broker")}</th><th>${L(lang, "الشركة", "Agency")}</th><th>${L(lang, "انضم", "Joined")}</th><th>${L(lang, "آخر نشاط", "Last active")}</th><th>${L(lang, "واقف عند", "Stuck at")}</th><th></th></tr></thead>
  <tbody>${stuck.map(
    (b) => html`<tr data-stuck="${b.id}"><td>${b.name} <span class="muted">(${b.role})</span></td><td>${b.agency_name}</td><td dir="ltr">${day(b.created_at)}</td><td dir="ltr">${day(b.last_active_at)}</td>
    <td>${b.reasons.map((r) => (STUCK[r] || [r, r])[lang === "en" ? 1 : 0]).join(" · ")}</td>
    <td><a class="btn secondary" target="_blank" rel="noopener" href="https://wa.me/${String(b.phone_number).replace(/[^0-9]/g, "")}">💬 ${L(lang, "كلّمه", "Message")}</a></td></tr>`
  )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش حد واقف دلوقتي.", "Nobody is stuck right now.")}</p>`}
</section>`;
}

/** Owner: plans, bundles, credits per action, rates, margins, credit requests and per-agency grants (all stored in the database). */
function creditsSection(o, lang) {
  const pct = (m) => (m === null || m === undefined ? "—" : `${Math.round(m * 100)}%`);
  const num = (name, v, extra = "") => html`<input name="${name}" type="number" min="0" value="${v}" size="6"${extra ? html` ${extra}` : ""}>`;
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  return html`<section class="card stack" id="credit-requests" data-credit-requests>
  <h2>🙋 ${L(lang, "طلبات زيادة الرصيد", "Credit requests")}</h2>
  ${o.requests.length
    ? html`<div class="scroll"><table><thead><tr><th>${L(lang, "الشركة", "Agency")}</th><th>${L(lang, "المدير", "Manager")}</th><th>${L(lang, "الطلب", "Asked")}</th><th></th></tr></thead>
  <tbody>${o.requests.map(
    (r) => html`<tr data-credit-request="${r.id}"><td>${r.agency_name}</td><td>${r.broker_name || "—"}</td><td>${r.credits}${r.note ? html` <span class="muted">${r.note}</span>` : ""} <span class="muted" dir="ltr">${day(r.created_at)}</span></td>
    <td><form method="post" action="/app/owner/credit-requests/${r.id}" class="row"><input name="credits" type="number" min="1" value="${r.credits}" size="6" aria-label="${L(lang, "الرصيد", "Credits")}">
      <button type="submit" name="decision" value="approve">${L(lang, "وافق", "Approve")}</button>
      <button type="submit" name="decision" value="decline" class="secondary">${L(lang, "ارفض", "Decline")}</button></form></td></tr>`
  )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش طلبات.", "No requests.")}</p>`}
  <form method="post" action="/app/owner/credit-grant" class="row" data-credit-grant>
    <label>${L(lang, "الشركة", "Agency")} <select name="agency" required>${o.agencies.map((a) => html`<option value="${a.id}">${a.name}</option>`)}</select></label>
    <label>${L(lang, "رصيد إضافي (للشهر الحالي)", "Extra credits (this month)")} <input name="credits" type="number" min="1" required size="6"></label>
    <label>${L(lang, "ملاحظة", "Note")} <input name="note" maxlength="100"></label>
    <button type="submit">${L(lang, "ادّي رصيد", "Give credits")}</button>
  </form>
</section>
<form method="post" action="/app/owner/credit-plans" class="card stack" id="credit-plans" data-credit-plans>
  <h2>💳 ${L(lang, "الباقات والرصيد", "Plans and credits")}</h2>
  <p class="muted">${L(lang, "كل الأرقام هنا من قاعدة البيانات وبتتطبق على الموقع والبوت فورًا. الهامش = السعر مقابل تكلفة الرصيد كله لو اتستخدم بالكامل.", "Every number here is stored in the database and applies to the site and the bot at once. Margin = price against the cost of the whole pool if fully used.")}</p>
  <div class="scroll"><table>
  <thead><tr><th>ID</th><th>${L(lang, "الاسم (ع)", "Name (ar)")}</th><th>${L(lang, "الاسم (إنجليزي)", "Name (en)")}</th><th>${L(lang, "السعر (ج.م/شهر)", "Price (EGP/month)")}</th><th>${L(lang, "مقاعد", "Seats")}</th><th>${L(lang, "وحدات", "Units")}</th><th>${L(lang, "رصيد/شهر", "Credits/month")}</th><th>${L(lang, "الأسعار حسب المدة (شهور:سعر)", "Prices by period (months:EGP)")}</th><th>${L(lang, "التكلفة", "Cost")}</th><th>${L(lang, "الهامش", "Margin")}</th><th>${L(lang, "مفعّلة", "On")}</th></tr></thead>
  <tbody>${o.plans.map(
    (p) => html`<tr data-credit-plan="${p.id}"><td dir="ltr">${p.id}</td>
    <td><input name="p_${p.id}_name_ar" value="${p.name_ar}" maxlength="40" required></td><td><input name="p_${p.id}_name_en" value="${p.name_en}" maxlength="40" required></td>
    <td>${num(`p_${p.id}_price`, p.price_egp)}</td><td>${num(`p_${p.id}_seats`, p.seats)}</td><td>${num(`p_${p.id}_units`, p.units)}</td><td>${num(`p_${p.id}_credits`, p.credits)}</td>
    <td>${p.id === "free" || p.id === "trial" ? "—" : html`<input name="p_${p.id}_prices" value="${Credits.pricesText(p.prices)}" size="22" dir="ltr" placeholder="1:199, 6:1075, 12:1990" data-plan-prices="${p.id}">`}</td>
    <td>${p.cost_egp}</td><td>${p.price_egp ? pct(p.margin) : "—"}</td>
    <td>${p.id === "free" ? "✔" : p.id === "trial" ? "—" : html`<input type="checkbox" name="p_${p.id}_active" value="on"${p.active ? html` checked` : ""}>`}</td></tr>`
  )}</tbody></table></div>
  <details><summary>➕ ${L(lang, "باقة جديدة", "Add a plan")}</summary><div class="row">
    <label>ID <input name="new_id" maxlength="20" pattern="[a-z0-9_]+" placeholder="team"></label>
    <label>${L(lang, "الاسم (ع)", "Name (ar)")} <input name="new_name_ar" maxlength="40"></label>
    <label>${L(lang, "الاسم (إنجليزي)", "Name (en)")} <input name="new_name_en" maxlength="40"></label>
    <label>${L(lang, "السعر", "Price")} <input name="new_price" type="number" min="0" size="6"></label>
    <label>${L(lang, "مقاعد", "Seats")} <input name="new_seats" type="number" min="1" size="4"></label>
    <label>${L(lang, "وحدات", "Units")} <input name="new_units" type="number" min="1" size="6"></label>
    <label>${L(lang, "رصيد/شهر", "Credits/month")} <input name="new_credits" type="number" min="0" size="6"></label>
    <label>${L(lang, "الأسعار حسب المدة", "Prices by period")} <input name="new_prices" size="22" dir="ltr" placeholder="1:199, 6:1075, 12:1990"></label>
  </div></details>
  <p class="muted">${L(lang, "الأسعار حسب المدة: شهور:سعر بفاصلة (مثال 1:199, 6:1075, 12:1990). المدة اللي مش مكتوبة مش متاحة للشراء. الباقة من غير أسعار مش بتتباع.", "Prices by period: months:price, comma separated (e.g. 1:199, 6:1075, 12:1990). A period left out is not sold; a plan with no prices cannot be bought.")}</p>
  <button type="submit">${L(lang, "احفظ الباقات", "Save plans")}</button>
</form>
<form method="post" action="/app/owner/grace-ai" class="card stack" id="grace-ai" data-grace-ai>
  <h2>⏳ ${L(lang, "رصيد الذكاء الاصطناعي في فترة السماح (باقات 6 و12 شهر)", "AI credits in the grace period (6 and 12 month plans)")}</h2>
  <p class="muted">${L(lang, "من غير تجديد شهري. الرصيد = الأكبر بين المتبقي من آخر شهر مدفوع ونسبة من رصيد شهر واحد (مش الاتنين مع بعض). الباقات الشهرية: المتبقي بس.", "No monthly refill. Credits = the greater of what is left of the last paid month and this share of one month's pool (not both). Monthly plans get only what is left.")}</p>
  <label>${L(lang, "النسبة %", "Share %")} <input name="grace_ai_pct" type="number" min="0" max="100" value="${o.graceAiPct}" size="4" required></label>
  <button type="submit">${L(lang, "احفظ", "Save")}</button>
</form>
<form method="post" action="/app/owner/credit-bundles" class="card stack" id="credit-bundles" data-credit-bundles>
  <h2>🧾 ${L(lang, "حزم الرصيد الإضافي", "Extra credit bundles")}</h2>
  <p class="muted">${L(lang, "الحزمة صالحة ٣٠ يوم من تاريخ التأكيد، وبتتحول للشهر اللي بعده.", "A bundle is valid for 30 days from confirmation and carries into the next month.")}</p>
  <div class="scroll"><table>
  <thead><tr><th>ID</th><th>${L(lang, "الاسم (ع)", "Name (ar)")}</th><th>${L(lang, "الاسم (إنجليزي)", "Name (en)")}</th><th>${L(lang, "السعر", "Price")}</th><th>${L(lang, "رصيد", "Credits")}</th><th>${L(lang, "التكلفة", "Cost")}</th><th>${L(lang, "الهامش", "Margin")}</th><th>${L(lang, "مفعّلة", "On")}</th></tr></thead>
  <tbody>${o.bundles.map(
    (b) => html`<tr data-credit-bundle="${b.id}"><td dir="ltr">${b.id}</td>
    <td><input name="b_${b.id}_name_ar" value="${b.name_ar}" maxlength="40" required></td><td><input name="b_${b.id}_name_en" value="${b.name_en}" maxlength="40" required></td>
    <td>${num(`b_${b.id}_price`, b.price_egp)}</td><td>${num(`b_${b.id}_credits`, b.credits)}</td><td>${b.cost_egp}</td><td>${pct(b.margin)}</td>
    <td><input type="checkbox" name="b_${b.id}_active" value="on"${b.active ? html` checked` : ""}></td></tr>`
  )}</tbody></table></div>
  <details><summary>➕ ${L(lang, "حزمة جديدة", "Add a bundle")}</summary><div class="row">
    <label>ID <input name="new_bundle_id" maxlength="20" pattern="[a-z0-9_]+" placeholder="b2000"></label>
    <label>${L(lang, "الاسم (ع)", "Name (ar)")} <input name="new_bundle_name_ar" maxlength="40"></label>
    <label>${L(lang, "الاسم (إنجليزي)", "Name (en)")} <input name="new_bundle_name_en" maxlength="40"></label>
    <label>${L(lang, "السعر", "Price")} <input name="new_bundle_price" type="number" min="1" size="6"></label>
    <label>${L(lang, "رصيد", "Credits")} <input name="new_bundle_credits" type="number" min="1" size="6"></label>
  </div></details>
  <button type="submit">${L(lang, "احفظ الحزم", "Save bundles")}</button>
</form>
<form method="post" action="/app/owner/credit-actions" class="card stack" id="credit-actions" data-credit-actions>
  <h2>⚙️ ${L(lang, "الرصيد لكل إجراء", "Credits per action")}</h2>
  <div class="row">${o.actions.map((a) => html`<label>${a[lang === "en" ? "label_en" : "label_ar"] || a.action} ${num(`a_${a.action}`, a.credits, `data-action="${a.action}"`)}</label>`)}</div>
  <div class="row">
    <label>${L(lang, "سعر الدولار للتخطيط (ج.م)", "Planning rate (EGP per USD)")} <input name="fx" type="number" min="1" step="0.5" value="${o.fx}" size="6"></label>
    <label>${L(lang, "تكلفة الرصيد الواحد ($)", "Cost per credit ($)")} <input name="cost_usd" type="number" min="0.0001" max="1" step="0.0001" value="${o.costUsd}" size="8"></label>
  </div>
  <button type="submit">${L(lang, "احفظ", "Save")}</button>
</form>`;
}

/** Owner: every agency at a glance (plan in force, size, last seen), each linking to its own page. */
function agenciesSection(agencies, lang) {
  const src = { pilot: L(lang, "تجريبي مجاني", "Pilot"), paid: L(lang, "مدفوع", "Paid"), trial: L(lang, "تجربة", "Trial"), free: L(lang, "مجاني", "Free"), grace: L(lang, "سماح", "Grace"), readonly: L(lang, "قراءة فقط", "Read-only"), blocked: L(lang, "متوقفة", "Stopped") };
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");
  const founding = agencies.filter((a) => a.founding_partner).length;
  return html`<section class="card list" id="agencies"><h2>${L(lang, `الشركات (${agencies.length})`, `Agencies (${agencies.length})`)}</h2>
  <p class="muted small" data-founding-count="${founding}">⭐ ${L(lang, `شركاء مؤسسين: ${founding} من ${OwnerAgencies.FOUNDING_MAX}. بيتحدد من صفحة الشركة. المميزات التشغيلية (صفر رسوم تأسيس ومساعدة في نقل البيانات) بتتم يدوي، والكود بيثبّت سعر أول تجديد بس.`, `Founding Partners: ${founding} of ${OwnerAgencies.FOUNDING_MAX}. Set on the agency's page. The extras (no setup fee, migration help) are handled by hand; the code only locks the first renewal's price.`)}</p>
  <ul class="rows">${agencies.map(
    (a) => html`<li data-agency-row="${a.id}"><a class="listrow" href="/app/owner/agencies/${a.id}"><span><strong>${a.name}</strong><br><span class="muted small">${Plans.planName(a.effective.plan, lang)} · ${src[a.effective.source]}${a.effective.until ? ` ${L(lang, "لحد", "until")} ${day(a.effective.until)}` : ""} · ${L(lang, `${a.brokers} بروكر · ${a.units} وحدة · ${a.leads30} عميل/30 يوم`, `${a.brokers} brokers · ${a.units} units · ${a.leads30} leads/30d`)}</span></span>${a.suspended_at ? html`<b class="chip late">${L(lang, "موقوفة", "Suspended")}</b>` : a.approval === "pending" ? html`<b class="chip new">${L(lang, "مستنية", "Pending")}</b>` : html`<b class="muted small">${day(a.last_seen)}</b>`}</a></li>`
  )}</ul></section>`;
}

/** Owner: one agency's page with its controls. */
function agencyControlPage(a, lang, csrf, notice, founding = { used: 0, max: OwnerAgencies.FOUNDING_MAX }) {
  const hidden = html`<input type="hidden" name="_csrf" value="${csrf}">`;
  const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
  return html`<h1>${a.name}</h1>
${notice || ""}
<div class="kpis">
  <div class="kpi"><span class="muted small">${L(lang, "الباقة الحالية", "Plan in force")}</span><strong>${Plans.planName(a.effective.plan, lang)}</strong></div>
  <div class="kpi"><span class="muted small">${L(lang, "لحد", "Until")}</span><strong dir="ltr">${a.effective.until ? day(a.effective.until) : "—"}</strong></div>
  <div class="kpi"><span class="muted small">${L(lang, "بروكرز نشطين", "Active brokers")}</span><strong>${a.brokers}</strong></div>
  <div class="kpi"><span class="muted small">${L(lang, "وحدات متاحة", "Active units")}</span><strong>${a.units}</strong></div>
</div>
<section class="card stack" id="plan"><h2>${L(lang, "تغيير الباقة", "Change the plan")}</h2>
  <form method="post" action="/app/owner/agencies/${a.id}/plan" class="stack">${hidden}
    <div class="pills">${Plans.PLANS.map((p) => html`<label class="pill"><input type="radio" name="plan" value="${p.id}"${p.id === a.plan ? html` checked` : ""}><span>${Plans.planName(p, lang)}</span></label>`)}</div>
    <div class="grid two">
      <label>${L(lang, "مدفوعة لحد", "Paid until")}<input type="date" name="until" value="${day(a.paid_until)}"></label>
      <label>${L(lang, "أو عدد شهور من النهارده", "Or months from today")}<input type="number" name="months" min="0" max="36" inputmode="numeric"></label>
    </div>
    ${switchField({ name: "pilot", value: "1", on: a.pilot, lang, label: L(lang, "تجريبي مجاني (Pilot)", "Free pilot"), sentence: L(lang, "الشركة على باقة Office ببلاش لحد ما الـPOC يخلص.", "The agency is on the Office plan for free until the POC ends.") })}
    <button type="submit">${L(lang, "حفظ الباقة", "Save the plan")}</button>
  </form>
  <p class="muted small">${L(lang, "الأسعار في ملف الباقات؛ هنا بتغير باقة الشركة ومدتها بس.", "Prices live in the plans file; this only changes this agency's plan and dates.")}</p>
</section>
<section class="card stack" id="founding" data-founding-partner="${a.founding_partner ? "1" : "0"}"><h2>⭐ ${L(lang, "شريك مؤسس", "Founding Partner")}</h2>
  <p class="muted">${L(lang, `أول ${founding.max} شركة بس. المستخدمين: ${founding.used} من ${founding.max}. الشريك المؤسس بيتثبّت له سعر أول تجديد؛ الباقي (صفر رسوم تأسيس، مساعدة نقل البيانات) تشغيلي بإيدك.`, `First ${founding.max} agencies only. Used: ${founding.used} of ${founding.max}. A Founding Partner keeps the price for the first renewal cycle; the rest (no setup fee, migration help) is done by hand.`)}</p>
  <form method="post" action="/app/owner/agencies/${a.id}/founding" class="stack">${hidden}
    ${switchField({ name: "founding", value: "1", on: a.founding_partner, lang, label: L(lang, "شريك مؤسس", "Founding Partner"), sentence: L(lang, "تثبيت سعر التجديد الأول.", "Locks the price for the first renewal cycle.") })}
    <button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>
  </form>
</section>
<section class="card stack" id="analytics" data-analytics-enabled="${a.analytics_enabled ? "1" : "0"}"><h2>📈 ${L(lang, "تحليلات السوق", "Market analytics")}</h2>
  <p class="muted">${L(lang, "لو فتحتها، مديرين الشركة (مش البروكرز) بيشوفوا صفحة «السوق»: مسار عملائهم جنب وسيط السوق وتقارير المناطق اللي عندهم فيها وحدات. الأرقام مجمّعة ومجهولة.", "When on, the agency's managers (not brokers) see the Market page: their own lead funnel next to the market median and reports for the places where they have units. The numbers are anonymous aggregates.")}</p>
  <form method="post" action="/app/owner/agencies/${a.id}/analytics" class="stack">${hidden}
    ${switchField({ name: "on", value: "1", on: a.analytics_enabled, lang, label: L(lang, "تحليلات السوق", "Market analytics"), sentence: L(lang, "الشركة تشوف صفحة السوق.", "The agency sees the Market page.") })}
    <button type="submit" class="secondary">${L(lang, "حفظ", "Save")}</button>
  </form>
</section>
<section class="card stack" id="extra-seats" data-extra-seats="${a.extra_seats || 0}"><h2>${L(lang, "مستخدمين إضافيين (إداري)", "Extra seats (admin)")}</h2>
  <p class="muted">${L(lang, `حاليا: ${a.extra_seats || 0} من ${Plans.EXTRA_SEAT.max}. ${Plans.EXTRA_SEAT.priceEgp} ج.م للمستخدم في الشهر، بتتحاسب مقدماً على الشهور اللي فاضلة، وكل مستخدم بيزود ${Plans.EXTRA_SEAT.credits} رصيد في الشهر. مش ظاهرة للشركة غير في الإجماليات. بتتصفر لما تبدأ فترة مدفوعة جديدة بعد الانتهاء.`, `Now: ${a.extra_seats || 0} of ${Plans.EXTRA_SEAT.max}. ${Plans.EXTRA_SEAT.priceEgp} EGP a seat a month, billed up front for the months left; each seat adds ${Plans.EXTRA_SEAT.credits} credits a month. Agencies only see it in their seat and credit totals. Reset when a new paid period starts after expiry.`)}</p>
  <form method="post" action="/app/owner/agencies/${a.id}/extra-seats" class="row" data-confirm="${L(lang, "تسجّل دفعة مؤكدة وتزود المستخدمين؟", "Record a confirmed payment and add the seats?")}">${hidden}
    <label>${L(lang, "عدد المستخدمين", "Seats")} <input name="seats" type="number" min="1" max="${Plans.EXTRA_SEAT.max}" required size="3"></label>
    <button type="submit">${L(lang, "ضيف", "Add")}</button>
  </form>
</section>
<section class="card list" id="team"><h2>${L(lang, "الفريق", "Team")}</h2><ul class="rows">${a.team.map((b) => html`<li class="listrow">${b.name} <span class="muted small">${b.role}</span><b class="${b.is_active ? "muted small" : "chip late"}">${b.is_active ? L(lang, "نشط", "Active") : L(lang, "مقفول", "Off")}</b></li>`)}</ul></section>
${a.payments.length ? html`<section class="card list"><h2>${L(lang, "المدفوعات", "Payments")}</h2><ul class="rows">${a.payments.map((p) => html`<li class="listrow"><span dir="ltr">${p.reference}</span> ${money(p.amount_egp, lang)}<b class="muted small">${p.status}</b></li>`)}</ul></section>` : ""}
<section class="card stack" id="suspend"><h2>${a.suspended_at ? L(lang, "الشركة موقوفة", "Suspended") : L(lang, "إيقاف الشركة", "Suspend the agency")}</h2>
  <p class="muted">${a.suspended_at ? L(lang, `اتوقفت ${day(a.suspended_at)}. الرجوع بيرجّع نفس البروكرز اللي كانوا شغالين.`, `Suspended ${day(a.suspended_at)}. Resuming brings back the same brokers.`) : L(lang, "كل البروكرز بيقفوا عن الشغل (البيانات بتفضل كما هي) لحد ما ترجعها.", "Every broker stops working (all data stays) until you resume it.")}</p>
  <form method="post" action="/app/owner/agencies/${a.id}/${a.suspended_at ? "resume" : "suspend"}" data-confirm="${a.suspended_at ? L(lang, "ترجع الشركة؟", "Resume this agency?") : L(lang, `توقف ${a.name}؟`, `Suspend ${a.name}?`)}">${hidden}<button type="submit" class="${a.suspended_at ? "" : "danger"}">${a.suspended_at ? L(lang, "رجّع الشركة", "Resume") : L(lang, "أوقف الشركة", "Suspend")}</button></form>
</section>
<p><a class="btn secondary small" href="/app/owner/agencies/${a.id}/ai-log">${L(lang, "سجل الذكاء الاصطناعي", "AI log")}</a></p>`;
}

/** Owner: an announcement to every manager, and the owner's own action log. */
function announceSection(log, lang, csrf) {
  const label = { owner_plan: L(lang, "تغيير باقة", "Plan change"), owner_suspend: L(lang, "إيقاف", "Suspend"), owner_resume: L(lang, "رجوع", "Resume"), owner_announcement: L(lang, "إعلان", "Announcement"), owner_founding: L(lang, "شريك مؤسس", "Founding Partner"), owner_extra_seats: L(lang, "مستخدمين إضافيين", "Extra seats"), owner_analytics: L(lang, "تحليلات السوق", "Market analytics") };
  return html`<section class="card stack" id="announce"><h2>${L(lang, "إعلان لكل المديرين", "Announcement to every manager")}</h2>
  <form method="post" action="/app/owner/announce" class="stack" data-confirm="${L(lang, "تبعت الإعلان لكل المديرين؟", "Send this to every manager?")}"><input type="hidden" name="_csrf" value="${csrf}">
    <label>${L(lang, "العنوان", "Title")}<input name="title" required maxlength="120"></label>
    <label>${L(lang, "التفاصيل (اختياري)", "Details (optional)")}<textarea name="body" rows="3" maxlength="600"></textarea></label>
    <button type="submit">${L(lang, "ابعت", "Send")}</button>
  </form></section>
<section class="card list" id="owner-log"><h2>${L(lang, "سجل تصرفاتك", "Your actions log")}</h2>
  ${log.length ? html`<ul class="rows">${log.map((r) => html`<li class="listrow"><span>${label[r.operation_type] || r.operation_type}${r.agency ? ` · ${r.agency}` : ""}${r.metadata?.plan ? ` · ${r.metadata.plan}` : ""}${r.metadata?.title ? ` · ${r.metadata.title}` : ""}</span><b class="muted small" dir="ltr">${new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ")}</b></li>`)}</ul>` : html`<p class="muted">${L(lang, "مفيش لسه.", "Nothing yet.")}</p>`}
</section>`;
}

/** Demo requests from the landing page (offices of 15+ seats): the owner can start a guided 14-day pilot from each. */
function demosSection(demos, lang, csrf) {
  return html`<section class="card" id="demos">
  <h2>📅 ${L(lang, "طلبات العرض المباشر (مكاتب ١٥+)", "Demo requests (offices 15+)")}</h2>
  ${(demos || []).length
    ? html`<div class="scroll"><table><tbody>${demos.map(
        (t) => html`<tr data-demo="${t.id}"><td dir="ltr">#D${t.id}</td><td>${t.name}</td><td>${t.agency_name || "—"}</td><td dir="ltr"><a href="tel:${t.phone_e164}">${t.phone_e164}</a></td><td>${t.team_size ?? "—"}</td><td dir="ltr">${new Date(t.created_at).toISOString().slice(0, 10)}</td>
  <td>${t.pilot_agency_id
          ? html`<a href="/app/owner/agencies/${t.pilot_agency_id}">${L(lang, "تجريبي اتعمل", "Pilot created")}</a>`
          : html`<form method="post" action="/app/owner/demos/${t.id}/pilot" data-confirm="${L(lang, `تعمل تجريبي ${AgencyCreate.PILOT_DAYS} يوم لـ ${t.agency_name || t.name}؟`, `Create a ${AgencyCreate.PILOT_DAYS}-day pilot for ${t.agency_name || t.name}?`)}"><input type="hidden" name="_csrf" value="${csrf}"><button type="submit" class="secondary">${L(lang, `تجريبي ${AgencyCreate.PILOT_DAYS} يوم`, `${AgencyCreate.PILOT_DAYS}-day pilot`)}</button></form>`}</td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش لسه.", "None yet.")}</p>`}
</section>`;
}

function ownerPage(d, lang, { billing = null, notice = null, reading = [], credits = null, referrals = null, intakes = { rows: [], summary: { active: 0, disconnected: 0, leads30: 0, failed30: 0, graphCalls30: 0 }, agencies: [], log: [] }, openTab = 0, stuck = [], agencies = [], log = [], csrf = "", places = { groups: [], topAreas: [], subzones: [] }, analytics = null } = {}) {
  const usd = (n) => `$${Number(n).toFixed(n < 1 ? 4 : 2)}`;
  return html`<h1>${L(lang, "متابعة التطبيق", "App tracking")}</h1>
${notice || ""}
${intakeBanner(intakes.rows, lang)}
${tabs("owner_tab", [
  [L(lang, "الشركات", "Agencies"), html`${agenciesSection(agencies, lang)}${demosSection(d.demos, lang, csrf)}${stuckSection(stuck, lang)}${announceSection(log, lang, csrf)}`],
  [L(lang, "الفلوس", "Money"), html`${billing ? billingSections(billing, lang) : ""}${referrals ? referralsSection(referrals, lang) : ""}${credits ? creditsSection(credits, lang) : ""}`],
  [L(lang, "ليدز فيسبوك", "Facebook leads"), intakeSection(intakes, lang, { baseUrl: require("../../lib/links").siteOrigin() })],
  [L(lang, "الأدوات", "Tools"), readingSection(reading, lang)],
  [L(lang, "الأماكن", "Places"), require("../views/placeReview").placesSection(places, lang, csrf)],
  [L(lang, "الصحة", "Health"), healthSections(d, lang, usd)],
  [L(lang, "تحليلات السوق", "Market analytics"), analytics ? AnalyticsView.ownerTab(analytics.data, analytics.status, lang, csrf) : ""]
], { open: openTab })}`;
}

function healthSections(d, lang, usd) {
  return html`<section class="card">
  <h2>${L(lang, "كل أسبوع", "Weekly")}</h2>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الأسبوع", "Week")}</th><th>${L(lang, "شركات نشطة", "Active agencies")}</th><th>${L(lang, "بروكرز نشطين", "Active brokers")}</th><th>${L(lang, "وحدات", "Units")}</th><th>${L(lang, "عملاء", "Leads")}</th><th>${L(lang, "صفقات", "Deals")}</th><th>${L(lang, "أخطاء", "Errors")}</th><th>${L(lang, "بلاغات", "Bug reports")}</th></tr></thead>
  <tbody>${d.weeks.map(
    (w) => html`<tr data-week="${w.week}"><td dir="ltr">${w.week}</td><td>${w.agencies}</td><td>${w.brokers}</td><td>${w.units}</td><td>${w.leads}</td><td>${w.deals}</td><td>${w.errors}</td><td>${w.reports}</td></tr>`
  )}</tbody></table></div>
  <p class="muted">${L(lang, "نشط = استخدم البوت أو الموقع في الأسبوع الحالي (الأسبوع بيبدأ الاتنين).", "Active = used the bot or the website that week (weeks start on Monday).")}</p>
</section>
<section class="card">
  <h2>${L(lang, "الذكاء الاصطناعي لكل شركة (آخر 30 يوم)", "AI per agency (last 30 days)")}</h2>
  <div class="scroll"><table>
  <thead><tr><th>${L(lang, "الشركة", "Agency")}</th><th>${L(lang, "بروكرز", "Brokers")}</th><th>Telegram</th><th>${L(lang, "طلبات AI", "AI calls")}</th><th>${L(lang, "فشلت", "Failed")}</th><th>${L(lang, "التكلفة", "Cost")}</th></tr></thead>
  <tbody>${d.agencies.map(
    (a) => html`<tr data-agency="${a.id}"><td><a href="/app/owner/agencies/${a.id}/ai-log" title="${L(lang, "سجل الذكاء الاصطناعي", "AI log")}">${a.name}</a></td><td>${a.brokers ?? 0}</td><td>${a.telegram ?? 0}</td><td>${a.calls}</td><td>${a.failed}</td><td dir="ltr">${usd(a.usd)}</td></tr>`
  )}</tbody>
  <tfoot><tr><td colspan="5">${L(lang, "الإجمالي", "Total")}</td><td dir="ltr" data-total-usd="${d.totalUsd.toFixed(4)}">${usd(d.totalUsd)}</td></tr></tfoot></table></div>
</section>
<section class="card">
  <h2>${L(lang, "أخطاء وبلاغات مفتوحة (آخر 7 أيام)", "Open errors and reports (last 7 days)")}</h2>
  ${d.topErrors.length
    ? html`<table><thead><tr><th>#</th><th>${L(lang, "النوع", "Kind")}</th><th>${L(lang, "المصدر", "Source")}</th><th>${L(lang, "الرسالة", "Message")}</th><th>${L(lang, "مرات", "Times")}</th></tr></thead>
  <tbody>${d.topErrors.map((e) => html`<tr><td dir="ltr">${e.kind === "report" ? "#R" : "#E"}${e.last_id}</td><td>${e.kind}</td><td>${e.source}</td><td dir="ltr">${String(e.message || "").slice(0, 140)}</td><td>${e.n}</td></tr>`)}</tbody></table>`
    : html`<p class="muted">✅ ${L(lang, "مفيش.", "None.")}</p>`}
</section>
<section class="card" id="error-log">
  <h2>${L(lang, "سجل الأخطاء (آخر 7 أيام)", "Error log (last 7 days)")}</h2>
  ${(d.recentErrors || []).length
    ? html`<div class="scroll"><table><thead><tr><th>#</th><th>${L(lang, "الوقت", "Time")}</th><th>${L(lang, "النوع", "Kind")}</th><th>${L(lang, "المصدر", "Source")}</th><th>${L(lang, "الرسالة", "Message")}</th><th>${L(lang, "مرات", "Times")}</th></tr></thead>
  <tbody>${d.recentErrors.map((e) => html`<tr data-error="${e.id}">
    <td dir="ltr">${e.kind === "report" ? "#R" : "#E"}${e.id}</td>
    <td dir="ltr">${new Date(e.created_at).toISOString().slice(0, 16).replace("T", " ")}</td>
    <td>${e.kind}</td><td dir="ltr">${e.source}</td>
    <td dir="ltr"><div>${String(e.message || "").slice(0, 300)}</div>${e.path ? html`<div class="muted">${e.path}</div>` : ""}
      <details><summary>${L(lang, "التفاصيل", "Details")}</summary>
      <pre dir="ltr">${e.stack || L(lang, "مفيش stack.", "No stack.")}</pre>
      <p class="muted" dir="ltr">agency ${e.agency_id || "—"} · broker ${e.broker_id || "—"}${e.resolved_at ? " · resolved" : ""}</p></details></td>
    <td>${e.n}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted">✅ ${L(lang, "مفيش أخطاء في آخر 7 أيام.", "No errors in the last 7 days.")}</p>`}
</section>
<section class="card" id="trials">
  <h2>🤝 ${L(lang, "طلبات التجربة (القديمة)", "Trial requests (legacy form)")}</h2>
  ${d.trials.length
    ? html`<div class="scroll"><table><tbody>${d.trials.map(
        (t) => html`<tr data-trial="${t.id}"><td dir="ltr">#T${t.id}</td><td>${t.name}</td><td>${t.agency_name || "—"}</td><td dir="ltr"><a href="tel:${t.phone_e164}">${t.phone_e164}</a></td><td>${t.team_size ?? "—"}</td><td dir="ltr">${new Date(t.created_at).toISOString().slice(0, 10)}</td></tr>`
      )}</tbody></table></div>`
    : html`<p class="muted">${L(lang, "مفيش لسه.", "None yet.")}</p>`}
</section>
<section class="card">
  <h2>${L(lang, "المهام الخلفية", "Background jobs")}</h2>
  <table><tbody>${d.jobs.map(
    (j) => html`<tr data-job="${j.name}"><td dir="ltr">${j.name}</td><td>${j.last_status === "failed" ? "❌" : j.last_status === "running" ? "⏳" : "✅"} ${j.last_status || "—"}</td><td dir="ltr">${j.last_finished_at ? new Date(j.last_finished_at).toISOString().slice(0, 16).replace("T", " ") : "—"}</td></tr>`
  )}</tbody></table>
</section>`;
}

/** Per-person AI use this month (numbers only), for the agency's managers; each row links to that person's log. */
function aiPeopleSection(people, lang) {
  if (!people || !people.length) return "";
  const n = (v) => Number(v || 0).toLocaleString("en-US");
  return html`<section class="card" data-ai-people>
  <h2>🤖 ${L(lang, "استخدام الذكاء لكل شخص (الشهر ده)", "AI use per person (this month)")}</h2>
  <div class="scroll"><table><thead><tr><th>${L(lang, "الاسم", "Name")}</th><th>${L(lang, "الدور", "Role")}</th><th>${L(lang, "استخدم", "Used")}</th><th>${L(lang, "الحد", "Limit")}</th><th></th></tr></thead><tbody>${people.map(
    (p) => html`<tr><td>${p.name}</td><td>${p.role}</td><td>${n(p.used)}</td><td>${p.allowance === null || p.allowance === undefined ? "—" : n(p.allowance)}</td><td><a class="secondary button small" href="/app/usage#ai-limits">${L(lang, "الحدود", "Limits")}</a></td></tr>`
  )}</tbody></table></div>
</section>`;
}

/** The WhatsApp import in this agency over the period: how much the parser read alone, AI use, and corrections in review. */
function importSection(r, lang) {
  if (!r || !r.parser.posts) return "";
  const pc = (v) => (v === null || v === undefined ? "—" : `${v}%`);
  return html`<section class="card" data-import-report>
  <h2>📥 ${L(lang, "تحميل واتساب", "WhatsApp import")}</h2>
  <table class="kv"><tbody>
    <tr><th>${L(lang, "بوستات اتقرت", "Posts read")}</th><td>${r.parser.posts}</td></tr>
    <tr><th>${L(lang, "القارئ العادي كفى", "Read without AI")}</th><td>${pc(r.parser.complete_pct)}</td></tr>
    <tr><th>${L(lang, "اتستخدم الذكاء", "AI used")}</th><td>${pc(r.parser.ai_used_pct)}</td></tr>
    <tr><th>${L(lang, "صفوف اتعدلت في المراجعة", "Rows edited in review")}</th><td>${pc(r.review.edited_pct)}</td></tr>
  </tbody></table>
  <p><a class="secondary button small" href="/app/import">${L(lang, "تحميل جديد", "New import")}</a></p>
</section>`;
}

function register(web, { pool, page }) {
  web.get("/dashboard", async (req, res) => {
    const lang = langOf(req);
    const d = await Dash.agencyDashboard(pool, req.session.broker, { days: req.query.days, brokerId: String(req.query.broker || "") || null, teamLeadId: String(req.query.team || "") || null });
    if (!d) return res.status(403).type("text/plain").send(L(lang, "للمديرين بس", "Managers only"));
    const [leases, targets, quotas, scope] = await Promise.all([Leases.upcoming(pool, req.session.broker), Targets.progress(pool, req.session.broker.agency_id), Quotas.forAgency(pool, req.session.broker.agency_id), Privacy.scopeOf(pool, req.session.broker.agency_id)]);
    const brokersWrite = await Rights.brokersMayWrite(pool, req.session.broker.agency_id);
    const [aiPeople, importReport] = await Promise.all([AiUserLimits.people(pool, req.session.broker.agency_id), ChatImportReport.report(pool, { days: Number(d.days) || 30, agencyId: req.session.broker.agency_id })]);
    return page(req, res, { title: L(lang, "لوحة الشركة", "Agency dashboard"), nav: "dashboard", body: html`${agencyPage(d, lang, {
      team: html`${targetsSection([...targets.values()], lang)}${leaseEnds(leases || [], lang)}`,
      ai: html`${aiPeopleSection(aiPeople, lang) || html`<p class="muted">${L(lang, "مفيش استخدام.", "No AI use yet.")}</p>`}${importSection(importReport, lang)}`,
      settings: html`${privacySection(scope, lang, req.session.csrf, req.query.privacy, isAgencyOwner(req.session.broker))}${brokerEditSection(brokersWrite, lang, req.session.csrf, isAgencyOwner(req.session.broker))}${leadScopeSection(await require("../../services/leadScope").brokersSeeAll(pool, req.session.broker.agency_id), lang, req.session.csrf, isAgencyOwner(req.session.broker))}${quotaSection(quotas, lang)}`,
      open: req.query.privacy ? 3 : 0,
      unitWarning: require("./plan").unitBanner(await Billing.unitStatus(pool, req.session.broker.agency_id), lang)
    })}` });
  });

  // Who sees a unit's private details (services/unitPrivacy.js); the agency owner only.
  web.post("/dashboard/secret-details", async (req, res) => {
    const out = await Privacy.setScope(pool, req.session.broker, String(req.body.scope || ""));
    if (!out.ok) return res.status(403).type("text/plain").send(L(langOf(req), "لمالك الشركة بس", "Agency owner only"));
    if (req.body.return === "settings") return res.redirect(303, "/app/settings?saved=1#data-security");
    return res.redirect(303, "/app/dashboard?privacy=saved#data-security");
  });

  // Brokers adding and editing units (services/unitRights.js); the agency owner only.
  web.post("/dashboard/brokers-edit-units", async (req, res) => {
    const out = await Rights.setBrokersMayWrite(pool, req.session.broker, req.body.allowed === "on");
    if (!out.ok) return res.status(403).type("text/plain").send(L(langOf(req), "لمالك الشركة بس", "Agency owner only"));
    if (req.body.return === "settings") return res.redirect(303, "/app/settings?saved=1#broker-edit");
    return res.redirect(303, "/app/dashboard?privacy=saved#broker-edit");
  });

  // What brokers see of the agency's leads (services/leadScope.js); the agency owner only.
  web.post("/dashboard/brokers-see-all-leads", async (req, res) => {
    const out = await require("../../services/leadScope").setBrokersSeeAll(pool, req.session.broker, req.body.allowed === "on");
    if (!out.ok) return res.status(403).type("text/plain").send(L(langOf(req), "لمالك الشركة بس", "Agency owner only"));
    if (req.body.return === "settings") return res.redirect(303, "/app/settings?saved=1#lead-scope");
    return res.redirect(303, "/app/dashboard?privacy=saved#lead-scope");
  });

  // The whole inventory as Excel: managers only, and every download is logged.
  web.get("/units-export.xlsx", async (req, res) => {
    const { broker } = req.session;
    if (!isManager(broker)) return res.status(403).type("text/plain").send(L(langOf(req), "للمديرين بس", "Managers only"));
    const t0 = Date.now();
    try {
      await Audit.recordStrict(pool, { agencyId: broker.agency_id, brokerId: broker.id, action: "command_inventory_export", payload: { channel: "web" } });
    } catch {
      return res.status(503).type("text/plain").send(L(langOf(req), "مقدرناش نسجّل التنزيل فمنفذش. جرّب تاني بعد شوية.", "Could not record this download, so it was not done. Try again shortly."));
    }
    const { rows: listings } = await pool.query("SELECT * FROM listings WHERE " + Vis.units("listings") + " AND agency_id = $1 AND status = 'active' ORDER BY created_at DESC", [broker.agency_id]);
    const { rows: agencies } = await pool.query("SELECT * FROM agencies WHERE id = $1", [broker.agency_id]);
    const buf = await require("../../lib/excel").buildAgencyInventoryWorkbook({ listings, agency: agencies[0], broker, lang: langOf(req) });
    logOperation(pool, { agency_id: broker.agency_id, broker_id: broker.id, operation_type: "command_inventory_export", status: "success", total_duration_ms: Date.now() - t0, metadata: { channel: "web", rowsCount: listings.length } });
    return res
      .set({ "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="Inventory_${new Date().toISOString().slice(0, 10)}.xlsx"` })
      .send(buf);
  });

  const ownerView = async (req, res, notice = null, status = 200, { tab: tab0 = 0 } = {}) => {
    let tab = tab0;
    const d = await Dash.ownerDashboard(pool, req.session.broker);
    if (!d) return notFound(req, res, page);
    const per = Period.parse(req.query.period);
    const pf = await Dash.ownerPeriod(pool, req.session.broker, per);
    const cell = (ar, en, k) => html`<div class="card" data-figure><span class="muted">${L(langOf(req), ar, en)}</span><strong>${pf.now[k]}</strong> <span class="muted small">${Period.change(pf.now[k], pf.before[k])}</span></div>`;
    const strip = html`<section data-owner-period>${Period.tabs("/app/owner", { period: per.key }, per.key, langOf(req))}<div class="grid">${cell("شركات نشطة", "Active agencies", "agencies")}${cell("بروكرز نشطين", "Active brokers", "brokers")}${cell("وحدات جديدة", "New units", "units")}${cell("عملاء جداد", "New leads", "leads")}${cell("صفقات", "Deals", "deals")}${cell("أخطاء", "Errors", "errors")}${cell("بلاغات", "Reports", "reports")}</div></section>`;
    const [open, signups, payments, payTo, trials, reading, referrals, intakes, stuck, credits, lapsed] = await Promise.all([Signup.isOpen(pool), Signup.pending(pool), Billing.pendingPayments(pool), Billing.payTo(pool), Billing.trialAgencies(pool), PriceReading.overview(pool), Referrals.overview(pool), Intake.tracking(pool), Onboarding.stuckList(pool), Credits.ownerOverview(pool), Billing.lapsedAgencies(pool)]);
    const [agencies, log, places] = await Promise.all([OwnerAgencies.list(pool), OwnerAgencies.auditLog(pool), PlaceReview.queue(pool)]);
    const anPick = /^[0-9a-f-]{36}$/i.test(String(req.query.an_agency || "")) ? String(req.query.an_agency) : null;
    if (anPick) tab = 6;
    const analytics = { data: await Analytics.forOwner(pool, req.session.broker, { agencyId: anPick }), status: await Analytics.status(pool) };
    return page(req, res, { title: L(langOf(req), "متابعة التطبيق", "App tracking"), nav: "owner", body: html`${strip}<p class="card"><a class="btn secondary small" href="/app/owner/board" data-admin-board-link>📊 ${L(langOf(req), "لوحة المالك (أرقام وتكاليف)", "Owner board (numbers and costs)")}</a></p><p class="card"><a class="btn secondary small" href="/app/owner/searches" data-search-review-link>🔎 ${L(langOf(req), "مراجعة البحث (كلمات جديدة وبلاغات وفحص الليل)", "Search review (new words, reports, nightly check)")}</a></p>${ownerPage(d, langOf(req), { billing: { open, signups, payments, payTo, trials, lapsed, csrf: req.session.csrf }, notice, reading, credits, referrals, intakes, openTab: tab, stuck, agencies, log, places, analytics, csrf: req.session.csrf })}` }, status);
  };
  const ok = (text) => html`<p class="card notice ok" role="status">✅ ${text}</p>`;
  const bad = (text) => html`<p class="card notice bad" role="alert">❌ ${text}</p>`;
  const ownerOnly = (handler) => async (req, res) => {
    if (!Dash.isOwner(req.session.broker)) return notFound(req, res, page);
    return handler(req, res, langOf(req));
  };
  const idParam = (req) => (/^\d{1,12}$/.test(req.params.id) ? Number(req.params.id) : null);
  const uuidParam = (req) => (/^[0-9a-f-]{36}$/i.test(req.params.id) ? req.params.id : null);

  web.get("/owner", (req, res) => ownerView(req, res));

  // One agency's page and its controls (plan, suspend), and an announcement to every manager.
  const agencyView = async (req, res, lang, notice = null, status = 200) => {
    const a = uuidParam(req) ? await OwnerAgencies.get(pool, req.params.id) : null;
    if (!a) return notFound(req, res, page);
    return page(req, res, { title: a.name, nav: "owner", body: agencyControlPage(a, lang, req.session.csrf, notice, await OwnerAgencies.foundingCount(pool)) }, status);
  };
  web.get("/owner/agencies/:id", ownerOnly((req, res, lang) => agencyView(req, res, lang)));
  web.post("/owner/agencies/:id/plan", ownerOnly(async (req, res, lang) => {
    if (!uuidParam(req)) return notFound(req, res, page);
    const r = await OwnerAgencies.setPlan(pool, req.session.broker, req.params.id, { plan: req.body.plan, until: req.body.until || null, months: req.body.until ? null : req.body.months ?? null, pilot: req.body.pilot === "1" });
    if (r.error === "not_found") return notFound(req, res, page);
    if (r.error) return agencyView(req, res, lang, bad(L(lang, "راجع الباقة والتاريخ.", "Check the plan and the date.")), 422);
    return agencyView(req, res, lang, ok(L(lang, "الباقة اتحفظت.", "Plan saved.")));
  }));
  web.post("/owner/agencies/:id/founding", ownerOnly(async (req, res, lang) => {
    if (!uuidParam(req)) return notFound(req, res, page);
    const r = await OwnerAgencies.setFounding(pool, req.session.broker, req.params.id, req.body.founding === "1");
    if (r.error === "not_found") return notFound(req, res, page);
    if (r.error === "full") return agencyView(req, res, lang, bad(L(lang, `وصلت لـ ${r.max} شريك مؤسس. مفيش أماكن تانية.`, `All ${r.max} Founding Partner places are taken.`)), 409);
    return agencyView(req, res, lang, ok(r.founding ? L(lang, "الشركة بقت شريك مؤسس.", "The agency is now a Founding Partner.") : L(lang, "اتشالت من الشركاء المؤسسين.", "Removed from the Founding Partners.")));
  }));
  web.post("/owner/agencies/:id/analytics", ownerOnly(async (req, res, lang) => {
    if (!uuidParam(req)) return notFound(req, res, page);
    const r = await Analytics.setEnabled(pool, req.session.broker, req.params.id, req.body.on === "1");
    if (r.error) return notFound(req, res, page);
    const note = ok(r.enabled ? L(lang, "تحليلات السوق اتفتحت للشركة.", "Market analytics is on for the agency.") : L(lang, "تحليلات السوق اتقفلت للشركة.", "Market analytics is off for the agency."));
    return req.body.from === "tab" ? ownerView(req, res, note, 200, { tab: 6 }) : agencyView(req, res, lang, note);
  }));
  web.get("/owner/analytics/:table", ownerOnly(async (req, res) => {
    const name = String(req.params.table).replace(/.csv$/, "");
    const r = await Analytics.exportCsv(pool, req.session.broker, name);
    if (r.error) return notFound(req, res, page);
    return res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="analytics_${name}_${new Date().toISOString().slice(0, 10)}.csv"` }).send("﻿" + r.csv);
  }));
  web.post("/owner/agencies/:id/extra-seats", ownerOnly(async (req, res, lang) => {
    if (!uuidParam(req)) return notFound(req, res, page);
    const r = await OwnerAgencies.addExtraSeats(pool, req.session.broker, req.params.id, req.body.seats);
    if (r.error === "not_found") return notFound(req, res, page);
    if (r.error) {
      const msg = { invalid: L(lang, `اكتب من 1 لـ ${Plans.EXTRA_SEAT.max} مستخدم.`, `Enter 1 to ${Plans.EXTRA_SEAT.max} seats.`), pilot: L(lang, "الشركة تجريبية (Pilot): مفيش مستخدمين إضافيين.", "A pilot agency can't have extra seats."), lapsed: L(lang, "الباقة خلصت (سماح / قراءة فقط / متوقفة): لازم تتجدد الأول.", "The plan has ended (grace / read-only / stopped): it must be renewed first."), not_paid: L(lang, "الشركة مش على باقة مدفوعة شغالة.", "The agency is not on a running paid plan."), limit: L(lang, `الحد الأقصى ${Plans.EXTRA_SEAT.max} مستخدمين إضافيين.`, `At most ${Plans.EXTRA_SEAT.max} extra seats in all.`), forbidden: L(lang, "مش مسموح.", "Not allowed.") }[r.error] || r.error;
      return agencyView(req, res, lang, bad(msg), r.error === "forbidden" ? 403 : 422);
    }
    return agencyView(req, res, lang, ok(L(lang, `اتضاف ${r.payment.seats} مستخدم. الدفعة ${r.payment.reference}: ${r.payment.amount_egp} ج.م.`, `Added ${r.payment.seats} seat(s). Payment ${r.payment.reference}: ${r.payment.amount_egp} EGP.`)));
  }));
  web.post("/owner/agencies/:id/suspend", ownerOnly(async (req, res, lang) => {
    if (!uuidParam(req)) return notFound(req, res, page);
    const r = await OwnerAgencies.suspend(pool, req.session.broker, req.params.id);
    if (r.error === "not_found") return notFound(req, res, page);
    return agencyView(req, res, lang, r.ok ? ok(L(lang, `اتوقفت (${r.brokers} بروكر).`, `Suspended (${r.brokers} brokers).`)) : bad(L(lang, "موقوفة بالفعل.", "Already suspended.")));
  }));
  web.post("/owner/agencies/:id/resume", ownerOnly(async (req, res, lang) => {
    if (!uuidParam(req)) return notFound(req, res, page);
    const r = await OwnerAgencies.resume(pool, req.session.broker, req.params.id);
    if (r.error === "not_found") return notFound(req, res, page);
    return agencyView(req, res, lang, r.ok ? ok(L(lang, `رجعت (${r.brokers} بروكر).`, `Resumed (${r.brokers} brokers).`)) : bad(L(lang, "مش موقوفة.", "Not suspended.")));
  }));
  web.post("/owner/announce", ownerOnly(async (req, res, lang) => {
    const r = await OwnerAgencies.announce(pool, req.session.broker, { title: req.body.title, body: req.body.body });
    return ownerView(req, res, r.ok ? ok(L(lang, `الإعلان اتبعت لـ ${r.sent} مدير.`, `Sent to ${r.sent} managers.`)) : bad(L(lang, "اكتب عنوان.", "Type a title.")), r.ok ? 200 : 422);
  }));

  web.post("/owner/signup", ownerOnly(async (req, res, lang) => {
    await Signup.setOpen(pool, req.body.open === "1");
    return ownerView(req, res, ok(req.body.open === "1" ? L(lang, "التسجيل اتفتح.", "Sign-up is open.") : L(lang, "التسجيل اتقفل.", "Sign-up is closed.")));
  }));

  // CRM owner only: create an agency and its owner; the owner's Telegram start link is shown once.
  web.post("/owner/agencies", ownerOnly(async (req, res, lang) => {
    const r = await AgencyCreate.createAgency(pool, req.session.broker, { agency: req.body.agency, logo: req.body.logo, ownerName: req.body.ownerName, ownerPhone: req.body.ownerPhone, plan: req.body.plan });
    if (r.error) {
      const msg = { agency: L(lang, "اكتب اسم الشركة.", "Enter the agency name."), logo: L(lang, "اللوجو لازم يكون لينك https.", "The logo must be an https link."), name: L(lang, "اكتب اسم المالك.", "Enter the owner's name."), phone: L(lang, "رقم موبايل مصري صحيح (01xxxxxxxxx).", "A valid Egyptian mobile (01xxxxxxxxx)."), plan: L(lang, "اختار باقة.", "Pick a plan."), phone_taken: L(lang, "الرقم ده مسجل بالفعل في شركة تانية.", "That number is already registered to another agency."), slug: L(lang, "مش قادر أعمل رابط للشركة دي؛ غيّر الاسم.", "Couldn't make a link for this agency name; change the name."), forbidden: L(lang, "مش مسموح.", "Not allowed.") }[r.error] || r.error;
      return ownerView(req, res, bad(msg), r.error === "forbidden" ? 403 : 400);
    }
    const link = r.url
      ? html`<p class="row" dir="ltr"><input readonly value="${r.url}" id="owner-start-link" aria-label="${L(lang, "لينك المالك", "Owner's link")}"> <button type="button" class="secondary" data-copy="#owner-start-link">📋 ${L(lang, "نسخ", "Copy")}</button></p>`
      : html`<p class="muted">${L(lang, "اللينك مش متعمل: TELEGRAM_BOT_USERNAME مش متظبط.", "No link made: TELEGRAM_BOT_USERNAME isn't set.")}</p>`;
    return ownerView(req, res, html`<section class="card notice ok" role="status" data-new-agency-done="${r.agency.id}"><h2>✅ ${L(lang, `${r.agency.name} اتعملت (${r.agency.pilot ? "تجريبي" : "تجربة"}).`, `${r.agency.name} is created (${r.agency.pilot ? "pilot" : "trial"}).`)}</h2>
      <p>${L(lang, "ابعت اللينك ده للمالك بنفسك. يتفتح مرة واحدة، وبيفتح البوت؛ من البوت يفتح الموقع.", "Send this link to the owner yourself. It works once and opens the bot; from the bot the website opens.")}</p>${link}</section>`);
  }));

  // CRM owner only: a guided 14-day multi-seat pilot from a demo request (Office, paid_until = now + 14 days); the owner's start link is shown once.
  web.post("/owner/demos/:id/pilot", ownerOnly(async (req, res, lang) => {
    const id = idParam(req);
    const { rows } = id ? await pool.query("SELECT id, name, agency_name, phone_e164 FROM demo_requests WHERE id = $1 AND kind = 'demo'", [id]) : { rows: [] };
    if (!rows[0]) return ownerView(req, res, bad(L(lang, "الطلب مش موجود.", "Request not found.")), 404);
    const dr = rows[0];
    const r = await AgencyCreate.createAgency(pool, req.session.broker, { agency: dr.agency_name || dr.name, ownerName: dr.name, ownerPhone: dr.phone_e164, plan: "pilot14", demoId: dr.id });
    if (r.error) {
      const msg = { phone: L(lang, "رقم الطلب مش موبايل مصري.", "The request's number is not an Egyptian mobile."), phone_taken: L(lang, "الرقم ده مسجل بالفعل في شركة.", "That number is already registered to an agency."), demo: L(lang, "اتعمل تجريبي للطلب ده قبل كده.", "A pilot was already created for this request."), forbidden: L(lang, "مش مسموح.", "Not allowed.") }[r.error] || r.error;
      return ownerView(req, res, bad(msg), r.error === "forbidden" ? 403 : 409);
    }
    const link = r.url
      ? html`<p class="row" dir="ltr"><input readonly value="${r.url}" id="owner-start-link" aria-label="${L(lang, "لينك المالك", "Owner's link")}"> <button type="button" class="secondary" data-copy="#owner-start-link">📋 ${L(lang, "نسخ", "Copy")}</button></p>`
      : html`<p class="muted">${L(lang, "اللينك مش متعمل: TELEGRAM_BOT_USERNAME مش متظبط.", "No link made: TELEGRAM_BOT_USERNAME isn't set.")}</p>`;
    return ownerView(req, res, html`<section class="card notice ok" role="status" data-new-agency-done="${r.agency.id}"><h2>✅ ${L(lang, `${r.agency.name}: تجريبي ${AgencyCreate.PILOT_DAYS} يوم اتعمل.`, `${r.agency.name}: ${AgencyCreate.PILOT_DAYS}-day pilot created.`)}</h2>
      <p>${L(lang, "ابعت اللينك ده للمالك بنفسك. يتفتح مرة واحدة.", "Send this link to the owner yourself. It works once.")}</p>${link}</section>`);
  }));

  // The owner decides on new places: approve as a new place, link to an existing one, or reject with a reason.
  const placeDone = (req, res, lang, r) => {
    const why = { name: ["لازم اسم.", "A name is needed."], area: ["لازم منطقة.", "An area is needed."], needs_area: ["لازم منطقة.", "An area is needed."], bad_subzone: ["المنطقة الفرعية مش تابعة للمنطقة دي.", "The sub-zone is not under that area."], coords: ["الإحداثيات مش صح.", "The coordinates are not valid."], reason: ["اكتب سبب الرفض.", "Write the reason."], duplicate: ["المكان ده موجود بالفعل.", "That place already exists."], no_place: ["اختار مكان موجود.", "Pick an existing place."], no_area: ["اختار منطقة موجودة.", "Pick an existing area."], has_children: ["المنطقة دي ليها مناطق فرعية.", "That area has sub-zones."], bad_parent: ["المنطقة التابعة لها مش مناسبة.", "That parent is not allowed."], not_pending: ["الطلب ده اتعمله قبل كده.", "This was already handled."] };
    if (r.error) return ownerView(req, res, bad(L(lang, ...(why[r.error] || why.not_pending))), r.error === "not_pending" ? 409 : 400);
    return ownerView(req, res, html`<p class="card" role="status" data-place-done>✅ ${L(lang, "اتحفظ", "Saved")}: ${r.name}</p>`);
  };
  web.post("/owner/places/:id/approve", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    return placeDone(req, res, lang, id ? await PlaceReview.approveCompound(pool, id, req.body) : { error: "not_pending" });
  }));
  web.post("/owner/places/:id/merge", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    return placeDone(req, res, lang, id ? await PlaceReview.mergeCompound(pool, id, req.body.into, { also: req.body.also }) : { error: "not_pending" });
  }));
  web.post("/owner/places/:id/reject", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    return placeDone(req, res, lang, id ? await PlaceReview.rejectName(pool, id, req.body.reason, { also: req.body.also }) : { error: "not_pending" });
  }));
  web.post("/owner/areas/:id/approve", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    return placeDone(req, res, lang, id ? await PlaceReview.approveArea(pool, id, req.body) : { error: "not_pending" });
  }));
  web.post("/owner/areas/:id/merge", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    return placeDone(req, res, lang, id ? await PlaceReview.mergeArea(pool, id, req.body.into) : { error: "not_pending" });
  }));
  web.post("/owner/areas/:id/reject", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    return placeDone(req, res, lang, id ? await PlaceReview.rejectArea(pool, id, req.body.reason) : { error: "not_pending" });
  }));

  web.post("/owner/signups/:id/approve", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Signup.approve(pool, id) : { error: "not_pending" };
    if (r.error) return ownerView(req, res, bad(L(lang, "الطلب مش مستني.", "That request isn't waiting.")), 400);
    const b = r.broker;
    const text = b.preferred_lang === "en"
      ? `Hi ${b.name}! ${r.agency.name} is on WehdatHub: a ${Plans.TRIAL.days}-day free trial (1 user, ${Plans.TRIAL.units} units, ${Plans.TRIAL.credits} AI credits). Tap this link to start on Telegram (works once, for 7 days): ${r.url || ""}`
      : `أهلاً ${b.name}! ${r.agency.name} اتفعّلت على WehdatHub: ${Plans.TRIAL.days} يوم تجربة مجانية (مستخدم واحد، ${Plans.TRIAL.units} وحدة، ${Plans.TRIAL.credits} رصيد ذكاء اصطناعي). دوس على اللينك ده عشان تبدأ على تيليجرام (يشتغل مرة واحدة، لمدة ٧ أيام): ${r.url || ""}`;
    const wa = r.url ? Phone.waMeUrl(b.phone_number, text) : null;
    return ownerView(req, res, html`<section class="card notice ok" role="status" data-approved="${r.agency.id}"><h2>✅ ${L(lang, `${r.agency.name} اتوافق عليها؛ التجربة شغالة.`, `${r.agency.name} approved; the trial has started.`)}</h2>
${r.url ? html`<p class="row" dir="ltr"><input readonly value="${r.url}" id="start-link" aria-label="${L(lang, "لينك البداية", "Start link")}"> <button type="button" class="secondary" data-copy="#start-link">📋 ${L(lang, "نسخ", "Copy")}</button></p>` : html`<p class="muted">${L(lang, "بوت تيليجرام مش متظبط (TELEGRAM_BOT_USERNAME).", "The Telegram bot isn't set up (TELEGRAM_BOT_USERNAME).")}</p>`}
${wa ? html`<p><a class="btn" href="${wa}" target="_blank" rel="noopener noreferrer">📤 ${L(lang, "ابعته على واتساب", "Send on WhatsApp")}</a></p>` : ""}</section>`);
  }));

  web.post("/owner/signups/:id/reject", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Signup.reject(pool, id) : { error: "not_pending" };
    return r.error ? ownerView(req, res, bad(L(lang, "الطلب مش مستني.", "That request isn't waiting.")), 400) : ownerView(req, res, ok(L(lang, `${r.agency.name} اترفضت.`, `${r.agency.name} rejected.`)));
  }));

  web.post("/owner/payments/:id/confirm", ownerOnly(async (req, res, lang) => {
    const id = idParam(req);
    const r = id ? await Billing.confirmPayment(pool, id) : { error: "not_found" };
    if (r.error === "upgrade_stale" || r.error === "not_allowed") return ownerView(req, res, bad(L(lang, "الدفع ده مبقاش ينفع يتأكد (الباقة اتغيرت أو الفترة خلصت). الغيه أو كلّم الشركة.", "This payment can no longer be confirmed (the plan changed or the period ended). Cancel it or contact the agency.")), 409);
    if (r.error) return ownerView(req, res, bad(L(lang, "الدفع ده مش مستني.", "That payment isn't waiting.")), 400);
    await BillingNotices.paymentConfirmed(pool, r).catch((e) => console.warn("Payment notice failed:", e.message));
    return ownerView(req, res, ok(L(lang, `${r.payment.reference} اتأكد.`, `${r.payment.reference} confirmed.`)));
  }));

  web.post("/owner/payments/:id/cancel", ownerOnly(async (req, res, lang) => {
    const id = idParam(req);
    const r = id ? await Billing.cancelPayment(pool, id) : { error: "not_pending" };
    return r.error ? ownerView(req, res, bad(L(lang, "الدفع ده مش مستني.", "That payment isn't waiting.")), 400) : ownerView(req, res, ok(L(lang, `${r.payment.reference} اتلغى.`, `${r.payment.reference} cancelled.`)));
  }));

  web.post("/owner/trials/:id/extend", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Billing.extendTrial(pool, id, req.body.days) : { error: "not_found" };
    if (r.error) return ownerView(req, res, bad(L(lang, "مينفعش تمدّد دي.", "That trial can't be extended.")), 400);
    const until = new Date(r.agency.trial_ends_at).toISOString().slice(0, 10);
    return ownerView(req, res, ok(L(lang, `تجربة ${r.agency.name} اتمدّت لحد ${until}.`, `${r.agency.name}'s trial now ends ${until}.`)));
  }));

  web.post("/owner/grace/:id/extend", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Billing.extendGrace(pool, id, req.body.days) : { error: "not_found" };
    if (r.error) return ownerView(req, res, bad(L(lang, "مينفعش تمدّد السماح دي (لازم باقة مدفوعة انتهت).", "That grace can't be extended (it needs a paid plan that ended).")), 400);
    const until = new Date(r.agency.grace_extra_until).toISOString().slice(0, 10);
    return ownerView(req, res, ok(L(lang, `سماح ${r.agency.name} اتمدّد لحد ${until}.`, `${r.agency.name}'s grace now runs to ${until}.`)));
  }));

  web.post("/owner/referrals", ownerOnly(async (req, res, lang) => {
    const id = /^[0-9a-f-]{36}$/i.test(String(req.body.agency || "")) ? req.body.agency : null;
    const r = id ? await Referrals.link(pool, id, req.body.code) : { error: "referral" };
    const why = {
      referral: L(lang, "الكود ده مش موجود.", "That code doesn't exist."),
      self: L(lang, "الشركة مينفعش تدعي نفسها.", "An agency can't invite itself."),
      paid: L(lang, "الشركة دي دفعت قبل كده.", "That agency has already paid."),
      already: L(lang, "الشركة دي مربوطة بدعوة بالفعل.", "That agency is already linked to an invite.")
    };
    if (r.error) return ownerView(req, res, bad(why[r.error]), 400);
    return ownerView(req, res, ok(L(lang, `اتربطت بدعوة ${r.referrer.name}.`, `Linked to ${r.referrer.name}'s invite.`)));
  }));

  web.post("/owner/price-reading/:id", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await PriceReading.setForAgency(pool, id, req.body) : { error: "not_found" };
    if (r.error) return ownerView(req, res, bad(L(lang, `الصفحات رقم من 0 لـ ${Reading.MAX_PAGES_MONTH}.`, `Pages must be 0 to ${Reading.MAX_PAGES_MONTH}.`)), 400);
    return ownerView(req, res, ok(r.setting.enabled ? L(lang, `${r.agency.name}: القراية مفعّلة، من الرصيد.`, `${r.agency.name}: reading on (uses credits).`) : L(lang, `${r.agency.name}: القراية مقفولة.`, `${r.agency.name}: reading off.`)));
  }));

  const creditsDone = async (req, res, lang, r, done, fail) => {
    if (r.error) return ownerView(req, res, bad(fail), 400);
    return ownerView(req, res, ok(done));
  };

  web.post("/owner/credit-plans", ownerOnly(async (req, res, lang) =>
    creditsDone(req, res, lang, await Credits.savePlans(pool, req.body), L(lang, "الباقات اتحفظت.", "Plans saved."), L(lang, "راجع أرقام الباقات: الاسم والسعر والمقاعد والوحدات والرصيد (ID الجديد حروف إنجليزي صغيرة وأرقام ومش مكرر).", "Check the plan numbers: names, price, seats, units, credits (a new ID is lowercase letters and digits and not already used)."))
  ));

  web.post("/owner/grace-ai", ownerOnly(async (req, res, lang) => {
    const n = /^\d{1,3}$/.test(String(req.body.grace_ai_pct || "").trim()) ? Number(req.body.grace_ai_pct) : null;
    if (n === null || n > 100) return creditsDone(req, res, lang, { error: true }, "", L(lang, "النسبة من 0 لـ 100.", "The share is 0 to 100."));
    await Billing.setSetting(pool, "grace_ai_pct", n);
    return creditsDone(req, res, lang, {}, L(lang, "النسبة اتحفظت.", "Share saved."), "");
  }));

  web.post("/owner/credit-bundles", ownerOnly(async (req, res, lang) =>
    creditsDone(req, res, lang, await Credits.saveBundles(pool, req.body), L(lang, "الحزم اتحفظت.", "Bundles saved."), L(lang, "راجع أرقام الحزم: الاسم والسعر والرصيد.", "Check the bundle numbers: name, price, credits."))
  ));

  web.post("/owner/credit-actions", ownerOnly(async (req, res, lang) => {
    const r = await Credits.saveActionsAndRates(pool, req.body);
    if (!r.error) await Credits.refresh(pool);
    return creditsDone(req, res, lang, r, L(lang, "الرصيد لكل إجراء اتحفظ.", "Credits per action saved."), L(lang, "الأرقام غلط: الرصيد من 0 لـ 1000، وسعر الدولار والتكلفة أرقام موجبة.", "Invalid numbers: credits 0 to 1000; the rate and cost must be positive."));
  }));

  web.post("/owner/credit-requests/:id", ownerOnly(async (req, res, lang) => {
    const id = parseInt(req.params.id, 10);
    const approve = req.body.decision === "approve";
    const r = Number.isInteger(id) ? await Credits.decideRequest(pool, id, { approve, credits: parseInt(req.body.credits, 10) || null }) : { error: "not_pending" };
    return creditsDone(req, res, lang, r, approve ? L(lang, "اتوافق، والرصيد اتضاف.", "Approved, credits added.") : L(lang, "اترفض.", "Declined."), L(lang, "الطلب مش موجود أو اتقرر فيه قبل كده.", "That request is gone or already decided."));
  }));

  web.post("/owner/credit-grant", ownerOnly(async (req, res, lang) => {
    const id = /^[0-9a-f-]{36}$/i.test(String(req.body.agency || "")) ? req.body.agency : null;
    const r = id ? await Credits.grant(pool, id, req.body.credits, { note: String(req.body.note || "").slice(0, 100) || null }) : { error: "credits" };
    return creditsDone(req, res, lang, r, L(lang, "الرصيد اتضاف للشركة.", "Credits added to the agency."), L(lang, "اختار شركة ورصيد من 1 لـ 1,000,000.", "Pick an agency and credits from 1 to 1,000,000."));
  }));

  // The intake actions return to the Facebook leads tab (tab 2).
  const FB_TAB = { tab: 2 };
  web.post("/owner/intake", ownerOnly(async (req, res, lang) => {
    const id = /^[0-9a-f-]{36}$/i.test(String(req.body.agency || "")) ? req.body.agency : null;
    const r = id ? await Intake.create(pool, id, { name: req.body.name, source: req.body.source, quietDays: req.body.quiet_days, pageId: req.body.page_id, pageToken: req.body.page_token }) : { error: "not_found" };
    if (r.error) {
      const msg = {
        fields: L(lang, "اكتب الاسم والمصدر والـ Page ID (أرقام) والتوكن.", "Fill in the name, source, Page ID (digits) and the token."),
        quiet_days: L(lang, "الأيام من 1 لـ 60.", "Quiet days must be 1 to 60."),
        page_token: L(lang, "فيسبوك رفض التوكن أو الـ Page ID. اتأكد إن التوكن بتاع نفس الصفحة وصلاحياته كاملة.", "Facebook rejected the token or Page ID. Check the token belongs to that Page and has all permissions."),
        subscribe: L(lang, "التوكن سليم بس الاشتراك في الصفحة فشل. اتأكد من صلاحية pages_manage_metadata.", "The token works but subscribing the Page failed. Check the pages_manage_metadata permission."),
        encryption_key: L(lang, "مفتاح تشفير التوكن (TOKEN_ENCRYPTION_KEY) مش متظبط على السيرفر.", "The token encryption key (TOKEN_ENCRYPTION_KEY) is not set on the server."),
        duplicate: L(lang, "الصفحة دي مربوطة بالفعل.", "That Page is already connected."),
        not_found: L(lang, "الشركة مش موجودة.", "Agency not found.")
      }[r.error];
      return ownerView(req, res, bad(msg), 400, FB_TAB);
    }
    return ownerView(req, res, ok(L(lang, `صفحة «${r.intake.page_name || r.intake.page_id}» اتربطت بـ ${r.agency.name}. دوس تجربة وبعدها جرّب Lead Ads Testing Tool.`, `Page "${r.intake.page_name || r.intake.page_id}" is connected to ${r.agency.name}. Press Test, then try Meta's Lead Ads Testing Tool.`)), 200, FB_TAB);
  }));

  web.post("/owner/intake/:id/test", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Intake.testIntake(pool, id) : { ok: false, error: "not_found" };
    if (r.ok) return ownerView(req, res, ok(L(lang, `التجربة نجحت: التوكن شغال والصفحة «${r.name || ""}» مشتركة في العملاء. مفيش عميل اتسجل.`, `Test passed: the token works and Page "${r.name || ""}" is subscribed to leads. No lead was saved.`)), 200, FB_TAB);
    const msg = r.error === "not_subscribed"
      ? L(lang, "التوكن شغال بس الصفحة مش مشتركة في leadgen. دوس حدّث التوكن.", "The token works but the Page is not subscribed to leadgen. Press Update token.")
      : r.error === "page_token"
        ? L(lang, "فيسبوك رفض التوكن (يمكن انتهى). هات توكن جديد ودوس حدّث التوكن.", "Facebook rejected the token (it may have expired). Get a new token and press Update token.")
        : L(lang, "التجربة فشلت: الربط متوقف أو مش موجود.", "Test failed: the connection is stopped or missing.");
    return ownerView(req, res, bad(msg), 400, FB_TAB);
  }));

  web.post("/owner/intake/:id/token", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Intake.updateToken(pool, id, req.body.page_token) : { error: "not_found" };
    if (r.error) {
      const msg = {
        fields: L(lang, "الصق التوكن الجديد (من غير مسافات).", "Paste the new token (no spaces)."),
        page_token: L(lang, "فيسبوك رفض التوكن الجديد. اتأكد إنه بتاع نفس الصفحة وصلاحياته كاملة.", "Facebook rejected the new token. Check it belongs to that Page and has all permissions."),
        subscribe: L(lang, "التوكن سليم بس الاشتراك في الصفحة فشل. اتأكد من صلاحية pages_manage_metadata.", "The token works but subscribing the Page failed. Check the pages_manage_metadata permission."),
        encryption_key: L(lang, "مفتاح تشفير التوكن (TOKEN_ENCRYPTION_KEY) مش متظبط على السيرفر.", "The token encryption key (TOKEN_ENCRYPTION_KEY) is not set on the server."),
        not_found: L(lang, "الربط متوقف أو مش موجود.", "The connection is stopped or missing.")
      }[r.error];
      return ownerView(req, res, bad(msg), 400, FB_TAB);
    }
    return ownerView(req, res, ok(L(lang, `التوكن اتغيّر والربط رجع شغال لـ «${r.intake.name}».`, `Token updated and "${r.intake.name}" is connected again.`)), 200, FB_TAB);
  }));

  web.post("/owner/intake/:id/revoke", ownerOnly(async (req, res, lang) => {
    const id = uuidParam(req);
    const r = id ? await Intake.revoke(pool, id) : { error: "not_found" };
    return r.error ? ownerView(req, res, bad(L(lang, "الربط متوقف بالفعل.", "That connection is already stopped.")), 400, FB_TAB) : ownerView(req, res, ok(L(lang, `«${r.intake.name}» اتوقف والتوكن اتمسح.`, `"${r.intake.name}" stopped and its token deleted.`)), 200, FB_TAB);
  }));

  web.post("/owner/pay-to", ownerOnly(async (req, res, lang) => {
    await Billing.savePayTo(pool, { instapay: req.body.instapay, bank: req.body.bank });
    return ownerView(req, res, ok(L(lang, "اتحفظ.", "Saved.")));
  }));
}

module.exports = { register, privacySection, brokerEditSection, leadScopeSection };
