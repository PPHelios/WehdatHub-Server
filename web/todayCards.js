// web/todayCards.js — The cards under the task list on Today (and the old units strip on a data entry person's Units page).
// They render the same result the app gets from /api/v1/today (services/today.js).
"use strict";

const { html } = require("./html");

const url = (code) => `/app/units/${encodeURIComponent(code)}`;

/** Old units: a row each opens the unit, with the unit's own Sold / Archive / Still available buttons there. */
function oldUnitsCard(c, en) {
  if (!c?.oldUnits) return "";
  const o = c.oldUnits;
  return html`<section class="card stack" data-today-card="old-units">
  <h2>${en ? `Units to check (${o.total})` : `وحدات محتاجة مراجعة (${o.total})`}</h2>
  <p class="muted">${en ? "Nobody has confirmed these for 21 days. Open a unit to mark it sold, archived or still available." : "محدش أكدها بقالها 21 يوم. افتح الوحدة وغيّر حالتها: اتباعت، أرشيف أو لسه متاحة."}</p>
  <ul class="rows">${o.items.map((u) => html`<li><a class="listrow" href="${url(u.code)}"><span><b>${u.code}</b> · ${u.line}</span><span class="muted">${u.hidden ? (en ? "hidden" : "مخفية") : en ? `${u.days} days` : `${u.days} يوم`}</span></a></li>`)}</ul>
  ${o.total > o.items.length ? html`<a class="btn secondary" href="/app/units?status=active">${en ? `${o.total - o.items.length} more` : `${o.total - o.items.length} كمان`}</a>` : ""}
</section>`;
}

function infoCards(c, en) {
  const rows = [];
  if (c.target) {
    const t = c.target;
    const parts = [];
    if (t.targetDeals) parts.push(en ? `${t.deals}/${t.targetDeals} deals` : `${t.deals}/${t.targetDeals} صفقات`);
    if (t.targetCommission) parts.push(`${t.commission.toLocaleString("en-US")}/${t.targetCommission.toLocaleString("en-US")} ${en ? "EGP" : "جنيه"}`);
    rows.push(html`<li><a class="listrow" href="/app/deals"><span>🎯 ${en ? "This month" : "هدف الشهر"}: ${parts.join(" · ")}</span><span class="muted">${en ? `${t.daysLeft} days left` : `فاضل ${t.daysLeft} يوم`}</span></a></li>`);
  }
  if (c.ops) {
    const o = c.ops;
    const scope = o.team ? (en ? "Your team" : "فريقك") : en ? "The agency" : "الشركة";
    const bits = [];
    if (o.unassigned) bits.push(en ? `${o.unassigned} with no broker` : `${o.unassigned} من غير بروكر`);
    if (o.uncontactedOld) bits.push(en ? `${o.uncontactedOld} not contacted in 24h` : `${o.uncontactedOld} محدش كلمهم 24 ساعة`);
    if (o.overdue) bits.push(en ? `${o.overdue} overdue` : `${o.overdue} متأخرة`);
    rows.push(html`<li><a class="listrow" href="/app/leads?tab=overdue"><span>👥 ${scope}: ${bits.join(" · ")}</span></a></li>`);
  }
  if (c.commissions) {
    const m = c.commissions;
    const bits = [];
    if (m.overdue) bits.push(en ? `${m.overdue} overdue` : `${m.overdue} متأخرة`);
    if (m.registrations) bits.push(en ? `${m.registrations} registrations about to lapse` : `${m.registrations} تسجيلات قربت تنتهي`);
    rows.push(html`<li><a class="listrow" href="/app/commissions"><span>💸 ${en ? "Commissions" : "العمولات"}: ${bits.join(" · ")}</span></a></li>`);
  }
  if (c.approvals) {
    const a = c.approvals;
    if (a.access) rows.push(html`<li><a class="listrow" href="/app/access-requests"><span>🔒 ${en ? `${a.access} private-details requests waiting` : `${a.access} طلب بيانات مستني موافقتك`}</span></a></li>`);
    if (a.names) rows.push(html`<li><a class="listrow" href="/app/owners"><span>✏️ ${en ? `${a.names} owner name changes waiting` : `${a.names} تعديل اسم مالك مستني موافقتك`}</span></a></li>`);
  }
  return rows.length ? html`<section class="card" data-today-card="info"><ul class="rows">${rows}</ul></section>` : "";
}

/** All the cards of a person's Today. */
function render(cards, en) {
  return html`${infoCards(cards, en)}${oldUnitsCard(cards, en)}`;
}

module.exports = { render, oldUnitsCard };
