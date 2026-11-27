# Phase 3 & Coached Accountability Design Specification

**Date:** 2026-11-25
**Repositories:** `WehdatHub-Server`, `WehdatHub-App`
**Selected Delivery Approach:** **Approach 1 — Two-Step Build** (Phase 3 Assistant + Option B Interactive Actions + Dashboard Update Discipline + Timer-Linked Telegram Buttons first; Phase 4 Automated Check-Ins & Full Dashboard Drill-Throughs in the follow-up release).

---

## 1. Intent & Why

Busy real-estate agency owners and managers open WehdatHub between meetings and phone calls. They need an executive cockpit and voice/text assistant (`SearchHome` + `VoiceBar`) that:
1. Surfaces **who is actually updating the app after each client action and who is going silent** — directly inside the Owner/Manager Dashboard and Assistant scorecards.
2. Ties **Coached Accountability** directly to the agency's existing `leadRules` round-robin response timer (`services/leadRules.js`) and 1-tap Telegram action callbacks (`ld:called:`, `ld:fu:`, `ld:stage:`, `ld:note:`), rather than adding noisy separate timers.
3. Lets owners/managers ask any question by voice or text (units, Primary projects, commissions, leads, broker accountability, marketing sources) and act **immediately inline (Option B)** via visual, animated answer cards without navigating 4 screens deep.

Meanwhile, a single server deployment serves **Live Web**, **Telegram Bot**, **Closed Testing App (`origin/main`)**, and **Internal Testing App** simultaneously — so all server changes must preserve 100% backward compatibility.

---

## 2. Goals, Non-Goals, and Anti-Goals

### Goals
- **App Update & Interaction Discipline metric** on `GET /api/v1/dashboard` (`board[]` + summary) and mobile Dashboard / Assistant, clearly separating consistent updaters from lagging/silent brokers.
- **Timer-linked Telegram Quick Actions (`tellMove` / `tellStop`)** plus manual **`🔔 Ask for update` Telegram Ping** (`POST /api/v1/leads/:ref/nudge`) and **Smart Reassign** right from stuck-lead and broker scorecard views.
- **"Share Update Summary"** clean non-PII copy/share helper for both brokers (after updating a lead/viewing) and owners (weekly/morning brief snapshot).
- **Spacious `✨` Composer (`VoiceBar`)** expanded up to 3 lines on demand, icon-only `✨` mode trigger that hides while typing/dictating, spring popover (`Auto` / `Resale` / `Primary` / `Reports`, Role Shortcuts, Recent 3), strictly keeping `Resale` and `Primary` isolated.
- **Additive `POST /api/v1/assistant/query` endpoint** running zero-credit deterministic local routing first before spending Gemini AI credits on open-ended / Primary Q&A.
- **Privacy-safe telemetry** (`analytics.ts` enums only; raw phone-scrubbed search logs strictly on server; `TIMED` latency tracking on new endpoints).

### Non-Goals (Deferred cleanly to Phase 4)
- Automated background cron nudges (midway SLA timer warning, 2h post-viewing outcome check-in, 2h opened-link broker silence check) — tracked explicitly as Phase 4 once Phase 3 Assistant & manual ping UX is validated in Internal Testing.
- Full Developer Commissions *Claimable vs. Overdue* breakdown cards, *Sources* month switcher + cohort label + FB Ad Burn alerts, and `TodayDetails`/`TodayCards` unification (Phase 4–5).
- Adding/editing properties from SearchHome (`SearchHome` stays strictly out of unit creation).

### Anti-Goals
- Breaking Live Web, Telegram default `services/search.js` behavior, or Closed Testing APK (`origin/main`).
- Modifying `packages/shared/src/tokens.ts` or `WehdatHub-Server/domain/designTokens.js` (token parity invariant).
- Mixing `Resale` and `Primary` clients/inventory automatically.
- Burning agency AI credits on trivial deterministic CRM metrics, navigation, or lead queue queries.
- Exposing client PII (names, phones, raw search queries) in Google Analytics or `operation_logs`.

---

## 3. Approaches Considered

- **Approach 1 — Two-Step Build (Chosen):** Ship `POST /api/v1/assistant/query` + `✨` `VoiceBar` + Option B inline cards (`Assign`, manual Telegram `🔔 Ask for update`, Share summary) + `tellMove`/`tellStop` Telegram quick-action buttons + Dashboard **Update Discipline** & `speedToLead.missed` metrics first; follow with automated midway SLA / post-viewing cron nudges and full Owner Dashboard drill-throughs in Phase 4.
  - *Why chosen:* Fastest, safest path to Internal Testing with zero new background scheduler locks or database migrations blocking release, while validating manual Telegram nudges and Option B card ergonomics with real owners first.
- **Approach 2 — All-In Bundle (Rejected):** Combine Assistant, all automated scheduler expansions, DB dedupe stamp columns, and full Phase 4 Dashboard drill-throughs in one release.
  - *Why rejected:* Doubles migration/cron/test surface area and delays real user feedback on the new cockpit and assistant UX.
- **Global `services/search.js` Rewrite / Fixed Mode Tabs (Rejected):** Rejected because changing default `search.js` alters Live Web/Telegram/Closed Testing behavior, and adding permanent switcher bars squeezes the viewport.

---

## 4. Architecture & Detailed Design (Phase 3 Scope)

### 4.1 Broker App Update / Interaction Discipline Metric (`services/dashboards.js` + Mobile Dashboard)
Computed read-only inside `brokerActivity(pool, agencyId, { since, until })` from existing `lead_events`, `leads`, `listings`, and `leadRules.speedToLead(...)` — scoped by `agency_id` and `Vis.leads` / `Vis.units` (zero new DB tables/migrations required):

Per active non-manager / active broker row in `board[]`, expose additive fields:
- `updates`: count of broker-initiated `lead_events` in period (`undone_at IS NULL AND kind IN ('contacted', 'stage', 'note', 'follow_up_set', 'follow_up_done', 'follow_up_postponed')`).
- `updates48h`: count of broker-initiated `lead_events` in the last `48h` (independent of selected `days` window so `silent` classification stays accurate on `90d`/`365d` views).
- `activeDays`: count of distinct Cairo dates (`Africa/Cairo`) in period where the broker logged >= 1 lead update.
- `lastUpdateAt`: ISO timestamp of the broker's latest logged `lead_events.created_at` (or `null` if never).
- `noNextStep`: current count of active open leads assigned to that broker where `stage NOT IN ('new', 'won', 'lost')` AND `follow_up_status IS DISTINCT FROM 'open'` (existing `no_next_step` definition).
- `staleOpen`: current count of open leads assigned to that broker (`stage NOT IN ('won', 'lost')`) with `last_activity_at < now - 48h` (and `stage <> 'new'` or already past initial grace).
- `missed`: count of leads that jumped away via `leadRules` (`data->>'reason' = 'no_response'`) over the period (`LeadRules.speedToLead`).
- `onTimePct`: `%` of responded rule-assigned leads answered within `wait_minutes` (nullable when 0 rule-assigned leads exist).
- `discipline`: pure classification computed in `domain/` (`consistent` | `lagging` | `silent`):
  - `silent`: `open >= 3` and `updates48h === 0`.
  - `lagging`: `staleOpen > 0` or `noNextStep >= 3` or (`open >= 3` and `missed > responded`).
  - `consistent`: updating open leads actively (or `< 3` open leads with no overdue drift).

**Headline Agency Summary (additive on `GET /api/v1/dashboard`):**
- `disciplineSummary`: `{ consistent, lagging, silent, totalNoNextStep, totalMissed }` for active brokers (`board`), enabling a crisp **"App Update Discipline"** card on Owner Dashboard (with filter tabs or sort toggle in Leaderboard: *Deals / Speed / Updates*).
- Brokers without `telegram_chat_id` linked while active (`telegramLinked: boolean` on `board[]` row) also surface a gentle *"Telegram not linked"* indicator in manager views so managers know nudges go only to in-app inbox/push.

### 4.2 Timer-Tied Coached Accountability & Telegram Quick Actions
1. **Enhance Existing `leadRules` Notifications (`services/leadRules.js`):**
   - `tellMove` (`lead_assigned` sent to the new broker): Attach 1-tap Telegram buttons already handled by `lib/leadIntake.js`:
     - `ld:called:${ref}` (`📞 Called`)
     - `ld:fu:${ref}` (`📅 Follow-up`)
   - `tellStop` (`lead_back` / `lead_jump_stop` sent to managers): Attach manager URL `/app/leads/${ref}` (preserving current behavior) and concise missed-jumps context (`response_jumps` count). Note: keep callback payloads short (`<= 64` bytes per Telegram `callback_data` limits).
2. **Manual Manager `"Ask for Update"` Ping (`POST /api/v1/leads/:ref/nudge`):**
   - **Auth & Tier:** Managers, Agency Owners, and Team Leads (for their own team's leads only; managers for any agency lead — enforced via existing `Leads.getLead` / `scope` + `Authz`). Returns `403` for plain brokers / data entry.
   - **Preconditions:** Lead must have `assigned_broker_id IS NOT NULL`, `stage NOT IN ('won', 'lost')`, and target broker must be active.
   - **Anti-spam cooldown:** Enforce a per-lead server rate limit (`1` manual ping per lead every `2` hours via `RateLimit.hit` or recent `notifications` dedupe window; returns `{ error: "too_many" }` / `429` if pinged repeatedly inside cooldown — register any new error code in `lib/errorText.js`).
   - **Delivery & Audit:** Calls `Notifications.notifyBroker(pool, holder, ...)` with kind `follow_up` (so it routes to Telegram + Push), carrying `ld:called:${ref}`, `ld:fu:${ref}`, `ld:note:${ref}` buttons, and logs `operation_type: 'lead_nudge'` in `operation_logs` (counts/actor/target lead id only — zero PII!).
3. **Broker Pause Auto-Leads Toggle (Surface Existing `away` / Order Control):**
   - Reuse existing `Team` / `LeadRules` availability endpoints from lagging broker scorecards (gated strictly by `allows(ws, "leadRules")` and `rights.manager`) — hidden cleanly on `team`/`solo` tiers where round-robin rules are unavailable.
4. **"Share Update Summary" Action:**
   - Mobile helper builds a crisp bilingual summary (ref + stage + compound/outcome or weekly executive brief totals) using React Native `Share.share` (consistent with `SearchScreen.tsx:452`) + logs a privacy-safe telemetry event.

### 4.3 `VoiceBar` Composer & `✨` Mode Popover (`WehdatHub-App`)
- **Composer (`VoiceBar.tsx` + `SearchScreen.tsx`):**
  - Replace the permanently visible greyed-out start-side trash icon on idle `SearchHome` with a **36×36 icon-only `✨` trigger button** (with a subtle indicator dot only when a non-`Auto` mode is locked).
  - **Auto-hide on text:** When `value.trim().length > 0` or transcribing, smoothly collapse the `✨` button (Reanimated `LinearTransition.reduceMotion(ReduceMotion.System)`) so the `TextInput` spans full width; move `Clear chat` cleanly to a contextual pill/action in active report/search headers.
  - **Multiline growth:** Set `multiline` on `VoiceBar` input with dynamic height up to **3 lines** (`maxHeight ~ 88`) and `submitBehavior="submit"` (RN 0.88) so the return key still submits instead of inserting blank lines, while long spoken transcripts wrap cleanly without horizontal cropping.
  - **Locked-mode display:** Changing mode to `Resale`, `Primary`, or `Reports` updates input placeholder text and optionally shows a compact dismissible chip **above** the composer (never inside the `TextInput` row), returning to `Auto` in 1 tap.
- **Animated `✨` Popover:**
  - Spring-animated bottom-anchored sheet (`ReduceMotion.System`) above `VoiceBar`:
    1. **Mode Switcher:** `Auto` (default) | `Resale` (Units only) | `Primary` (Projects/Developers only) | `Reports` (hidden if `data_entry`; scoped to personal/team vs manager metrics).
    2. **Role Shortcuts:** Pinned repeatable actions strictly filtered by `rights` + server `nav` (never exposing `Sources`, `WinLoss`, `Team`, or `Dashboard` where disallowed!).
    3. **Recent 3 Searches:** Kept inside the popover/tools sheet rather than crowding `SearchHome`.

### 4.4 Assistant Endpoint & Smart Routing (`POST /api/v1/assistant/query`)
- **Request:** `{ q: string, mode?: 'auto' | 'resale' | 'primary' | 'reports' }`
- **Response (strictly typed & additive):**
  ```json
  {
    "intent": "unit_search | primary | crm_leads | crm_broker | crm_commissions | crm_sources | crm_leases | crm_brief | clarify",
    "modeUsed": "auto | resale | primary | reports",
    "headline": "string",
    "windowLabel": "Last 30 days | ...",
    "cards": [ ... ],
    "actions": [ ... ],
    "links": [ { "label": "...", "screen": "...", "params": {} } ],
    "aiUsed": false
  }
  ```
- **Routing Order (Zero-Credit Deterministic First):**
  1. Validate input (`RateLimit.apiGate` + length bounds), whitelist `/assistant/query` as read-only in `lib/testRole.js` (`viewPostAllowed`), register `assistant` in `tests/security/routes.js` & `API_CONTRACTS.json`, and enforce `mode` isolation:
     - `mode = 'resale'` **always** routes strictly through Resale inventory search (accept optional `market: "resale"` constraint into `Search.search` / `runSearch` without altering Web/Telegram defaults; relaxed ±15% stays within Resale — **never falls back to Primary**, offers clean pivot button *"Try Primary projects?"* instead).
     - `mode = 'primary'` **always** routes to `services/assistant.js` + `projectSearch.js`.
     - `mode = 'reports'` routes only to deterministic CRM/Dashboard/Commission/Source/Broker handlers permitted for `req.session.broker`'s role & `workspace` (`allows(ws, feature)`).
  2. In `mode = 'auto'`:
     - Step 1: Deterministic CRM/Report classifier (`domain/` rule module) matches commissions, overdue/waiting leads, broker scorecard by name (managers/owners/team leads only inside own scope!), FB intake, leases, silent brokers, unit work — **0 AI credits spent**.
     - Step 2: Unit signal detector (`beds`, `area`, `budget`, `compound`, unit code, `resale`) runs Resale search (`Search.search`, relaxed ±15% only inside Resale).
     - Step 3: Primary / developer project questions route to `Assistant` (`services/assistant.js` / `projectSearch.js`).
     - Step 4: Ambiguous queries with no strong match return `intent: 'clarify'` with 1-tap mode/scope buttons instead of returning `"No units found"`.
- **Option B Inline Card Types (`cards[]` & `actions[]`):**
  - `metric_row` / `bar_breakdown` (reuses `SectionCard`, `KpiTile`, `StatRow`, animated bars).
  - `broker_scorecard`: displays broker's period deals, recorded commission, open leads, `waitingOver1h`, `medianResponseMin`, `missed`, `updates`, `activeDays`, `noNextStep`, `staleOpen`, `discipline` badge, plus direct deep-link to their stuck leads.
  - `stuck_leads`: up to 5 actionable lead items with **Smart Reassign** (`recommendedBrokers[]`: active, non-away, lowest open leads, excluding current holder -> triggers existing `POST /api/v1/leads/:ref/assign`) and **`🔔 Ask for update`** (`POST /api/v1/leads/:ref/nudge`).

### 4.5 Telemetry & Backward Compatibility
- **Google Analytics (`analytics.ts`, zero PII):** Append `home_priority_tapped`, `home_tip_tapped`, `home_tip_dismissed`, `assistant_query_run` (`{ intent, mode, ai_used, outcome, role }`), `assistant_action_tapped` (`{ action, role }`), `lead_nudge_sent`, `voice_transcript_outcome` (`{ action: 'sent_as_is' | 'edited' | 'cancelled' }`).
- **Server `usageLog.js` (`TIMED`):** Add `/dashboard`, `/today/home`, `/commissions`, `/sources`, `/assistant/query`, `/leads/:ref/nudge` so latency/error rates are monitored automatically.
- **Compatibility Guarantees:** Zero changes to `services/search.js` defaults (Telegram & Web untouched), zero changes to `designTokens.js` / `tokens.ts`, existing `/api/v1/dashboard` & `/api/v1/today/home` keys strictly preserved.

---

## 5. Phase 4–5 Boundary (Explicitly Out of Phase 3 Scope)
1. **Automated Scheduler Expansions (`services/leadRules.js` & `services/followUpReminders.js`):**
   - Pre-jump midway `response_due_at` warning (`50–75%` elapsed while uncontacted).
   - Automated `2h post-viewing outcome check-in` Telegram prompt (`[🔥 Interested] [🤝 Negotiation] [📅 Follow-up] [❌ Not fit]`).
   - Automated `2h opened-link silence check` + DB migration for dedupe timestamps (when needed).
2. **Owner Dashboard Full Drill-Throughs & Unification:**
   - Developer Commissions: separate *Claimable (not invoiced)* vs *Overdue*, tap developer row -> filtered `Commissions` list (`developerId` filter).
   - Marketing / Sources: Month switcher, explicit cohort clarification subtitle, `signedOnly` toggle, and silent ad-burn detection.
   - Unify `TodayDetails` / `TodayCards` urgency ordering across `Dashboard` and `Today` screens.

---

## 6. Left to the Builder (Planning & Execution Details)
- Exact SQL query structuring inside `services/dashboards.js` (`brokerActivity`) and clean PGlite compatibility (`WITH` / `LATERAL` patterns already proven in `dashboards.js`).
- Exact Arabic/English copy strings matching WehdatHub's Egyptian Arabic + concise English register (including registering any new API error code in `lib/errorText.js`).
- Component file organization inside `WehdatHub-App/apps/mobile/src/components/` (`AssistantCards.tsx`, `ComposerPopover.tsx`, etc.) keeping each file focused and covered by Jest/RNTL tests + Jest/Supertest server API/security/visibility-guard tests.
