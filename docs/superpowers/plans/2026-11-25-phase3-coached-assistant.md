# Phase 3 & Coached Accountability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver Phase 3 across `WehdatHub-Server` and `WehdatHub-App`: broker app-update discipline metrics (`consistent` / `lagging` / `silent`), timer-tied Telegram quick-action buttons and manual `Ask for update` nudges, multiline `VoiceBar` + `✨` mode popover (`Auto`/`Resale`/`Primary`/`Reports`), and `POST /api/v1/assistant/query` with Option B interactive operational cards and zero-PII telemetry.

**Architecture:** All server additions stay strictly additive on existing endpoints (`/api/v1/dashboard`, `leadRules.js`) and isolate the new smart assistant router behind `POST /api/v1/assistant/query`, leaving `services/search.js` defaults untouched for Live Web, Telegram, and Closed Testing APK (`origin/main`). Deterministic zero-credit CRM/metric/unit routing executes first before calling Gemini for open-ended Primary Q&A, while `WehdatHub-App` reuses `SectionCard`, `KpiTile`, `UrgencyBadge`, `StatRow`, `HomeRow`, `Chips`, and `theme.ts` contrast tokens with `ReduceMotion.System`.

**Tech Stack:** Node 24, Express 5, Postgres/PGlite, Jest & Supertest (`WehdatHub-Server`); TypeScript, React Native 0.88, React Query, Reanimated, Vitest & RNTL (`WehdatHub-App`).

**Spec:** [2026-11-25-phase3-coached-assistant-design.md](file:///d:/code/WehdatHub/WehdatHub-Server/docs/superpowers/specs/2026-11-25-phase3-coached-assistant-design.md)

## Global Constraints

- Backward compatibility: Never rename/remove existing keys on `/api/v1/dashboard`, `/api/v1/today/home`, `/api/v1/leads`, or alter default `services/search.js` / `Q.classifyIntent()` behavior for Web, Telegram, or Closed Testing (`origin/main`).
- Server invariants (`AGENTS.md`): Scope every SQL query by `agency_id`; wrap `listings`/`leads` queries with `Vis.units`/`Vis.leads`; never check `plan.id` / `isSolo(` outside `domain/segments.js` + `lib/workspace.js` (use `allows(ws, feature)`); register new API modules in `API_CONTRACTS.json` & `tests/security/routes.js`; register new error codes (AR + EN without `_`) in `lib/errorText.js`; zero client PII in logs, `operation_logs`, or GA events; zero runtime disk writes.
- UI/Token parity (`AGENTS.md`): Never edit `packages/shared/src/tokens.ts` or `WehdatHub-Server/domain/designTokens.js`; all animations use `.reduceMotion(ReduceMotion.System)`; multiline `VoiceBar` sets `submitBehavior="submit"` and grows up to 3 lines (`maxHeight: 88`); `✨` button fits 36x36 icon-only in empty state and collapses when typing/transcribing.
- Cooldowns & Role Gates: Manual lead nudge limited to `1` per lead per `2h` (`too_many` / `429`), refused `403` for `broker`/`data_entry`, and team-lead nudges scoped strictly to their team's leads. Full Dashboard & Assistant executive reports never leak agency totals to brokers/data entry.

## Review Focus

- `brokerActivity` `days=365` with zero updates in last 48h must still classify an overloaded broker (`open >= 3`) as `silent` via `updates48h`, while an active broker with `open <= 2` must stay `consistent` (`Task 1`).
- `POST /api/v1/leads/:ref/nudge` must reject unassigned/won/lost leads (`422`), out-of-team leads for a `team_lead` (`404`), and repeat pings within 2h (`429`) even across agencies (`Task 2`).
- `mode: 'resale'` on `/api/v1/assistant/query` when 0 strict results match must relax only within `resale` (never return `primary` listings/projects) and run cleanly under NCH read-only view mode (`Task 3`).
- Offline/legacy or gated workspace (`solo`/`team` missing `sources`/`winLoss`/`team`) must not show `403`-triggering shortcuts in `ComposerPopover` or crash when `board[]` lacks new optional discipline fields (`Tasks 4 & 5`).
- Voice dictation edited vs sent-as-is vs cancelled must clear cleanly without losing 3-line readability, and `Ask for update` cooldown `429` error surfaces translated copy without crashing the card (`Tasks 5 & 6`).

---

### Task 1: Broker App Update Discipline & Missed-Jump Metrics (`WehdatHub-Server`)

**Files:**
- Create: `WehdatHub-Server/domain/discipline.js`
- Modify: `WehdatHub-Server/services/dashboards.js:23-105,188-215`
- Modify: `WehdatHub-Server/API_CONTRACTS.json`
- Test: `WehdatHub-Server/tests/unit/discipline.test.js`
- Test: `WehdatHub-Server/tests/web/dashboard.test.js`

**Interfaces:**
- Produces (`domain/discipline.js`):
  - `classifyBroker({ active, open, updates48h, staleOpen, noNextStep, missed, responded }): 'consistent' | 'lagging' | 'silent'`
  - `summarizeBoard(board): { consistent: number, lagging: number, silent: number, totalNoNextStep: number, totalMissed: number }`
- Produces (`services/dashboards.js` additive on `board[]` items & `agencyDashboard` return):
  - Per `board[]` row: `updates`, `updates48h`, `activeDays`, `lastUpdateAt`, `noNextStep`, `staleOpen`, `missed`, `onTimePct`, `telegramLinked`, `discipline`
  - Top-level on `agencyDashboard`: `waitingOver1h` (already added on `un`), `disciplineSummary`

- [ ] **Step 1: Write failing unit & dashboard tests**
  - In `tests/unit/discipline.test.js`, test `classifyBroker` cases:
    - `{ active: true, open: 3, updates48h: 0, staleOpen: 0, noNextStep: 0, missed: 0, responded: 2 }` -> `'silent'`
    - `{ active: true, open: 2, updates48h: 0, staleOpen: 0, noNextStep: 0, missed: 0, responded: 0 }` -> `'consistent'` (below threshold `open < 3`)
    - `{ active: true, open: 4, updates48h: 1, staleOpen: 1, noNextStep: 0, missed: 0, responded: 2 }` -> `'lagging'`
    - `{ active: true, open: 4, updates48h: 1, staleOpen: 0, noNextStep: 3, missed: 0, responded: 2 }` -> `'lagging'`
    - `{ active: true, open: 4, updates48h: 1, staleOpen: 0, noNextStep: 0, missed: 3, responded: 2 }` -> `'lagging'`
    - `summarizeBoard([...])` counts each active broker accurately and totals `totalNoNextStep` and `totalMissed`.
  - In `tests/web/dashboard.test.js`, add regression test checking `agencyDashboard` returns `updates`, `updates48h === 0` when latest `lead_events` was 72h ago (even with `days: 365`), `missed` from `assigned` `no_response` events, `noNextStep`, `discipline: 'silent'` for a broker with 3 open untouched leads, and `disciplineSummary`.
- [ ] **Step 2: Run tests to verify failure**
  - Run: `cd WehdatHub-Server; node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/discipline.test.js tests/web/dashboard.test.js --runInBand`
  - Expected: FAIL (`Cannot find module '../../domain/discipline'`).
- [ ] **Step 3: Implement `domain/discipline.js` & wire `services/dashboards.js` + `API_CONTRACTS.json`**
  - Create `domain/discipline.js` (pure rules, zero DB, exports `{ classifyBroker, summarizeBoard }`).
  - In `services/dashboards.js` (`brokerActivity`), fetch `telegram_chat_id IS NOT NULL AS telegram_linked` on `brokers`, aggregate `lead_events` (`contacted`, `stage`, `note`, `follow_up_set`, `follow_up_done`, `follow_up_postponed`) for `[since, until)` (`updates`, `activeDays`, `lastUpdateAt`) and for `[until - 48h, until)` (`updates48h`), aggregate current `leads` per `assigned_broker_id` via `Vis.leads("l")` (`noNextStep`, `staleOpen` where `last_activity_at < until - 48h AND stage <> 'new'`), and call `LeadRules.speedToLead(pool, agencyId, { days, now: until })` for `missed` & `onTimePct`. Compute `discipline` via `Discipline.classifyBroker`. Keep every existing field untouched.
  - In `agencyDashboard`, compute `disciplineSummary` via `Discipline.summarizeBoard(board)` using active brokers. Avoid writing any comment matching `FROM leads` / `FROM listings` (`visibility-guard.test.js`).
  - Register `domain/discipline.js` in `API_CONTRACTS.json` and run `node scripts/api-contracts.js`.
- [ ] **Step 4: Run tests and guards**
  - Run: `cd WehdatHub-Server; node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/discipline.test.js tests/web/dashboard.test.js tests/web/dashboard-team.test.js tests/api/ownersApi.test.js tests/contract-guard.test.js tests/visibility-guard.test.js --runInBand`
  - Expected: PASS (all suites green).
- [ ] **Step 5: Commit Task 1**
  - Commit `domain/discipline.js`, `services/dashboards.js`, `API_CONTRACTS.json`, `tests/unit/discipline.test.js`, `tests/web/dashboard.test.js` in `WehdatHub-Server`.

---

### Task 2: Timer-Tied Telegram Buttons & `POST /api/v1/leads/:ref/nudge` (`WehdatHub-Server`)

**Files:**
- Modify: `WehdatHub-Server/services/leadRules.js:255-275`
- Modify: `WehdatHub-Server/services/leads.js` (add `nudgeLead` + export in `module.exports`)
- Modify: `WehdatHub-Server/api/leads.js:50-52,336-345`
- Modify: `WehdatHub-Server/lib/errorText.js` (if any new error code needed beyond `too_many`/`not_found`/`forbidden`)
- Modify: `WehdatHub-Server/API_CONTRACTS.json`
- Test: `WehdatHub-Server/tests/api/leads.test.js`
- Test: `WehdatHub-Server/tests/unit/api-error-words.test.js`
- Test: `WehdatHub-Server/tests/security/access.test.js`

**Interfaces:**
- Consumes: `Notifications.notifyBroker`, `RateLimit.hit`, `Leads.getLead`, `logOperation`
- Produces:
  - `services/leads.js` `nudgeLead(pool, actor, refOrId, { now }): Promise<{ ok: true, lead, channel } | { error }>`
  - `POST /api/v1/leads/:ref/nudge` -> `200 { ok: true }` | `403/404/422/429 { error, message }`

- [ ] **Step 1: Write failing tests in `tests/api/leads.test.js` and `tests/unit/lead-rules-buttons.test.js` (or existing leadRules test)**
  - Test `leadRules.tellMove` (`moveOverdue` notification to new broker) includes `buttons: [{ id: 'ld:called:...', ... }, { id: 'ld:fu:...', ... }]`.
  - Test `POST /api/v1/leads/:ref/nudge`:
    - Manager or Team Lead (for own team's lead) sends nudge -> `200 { ok: true }`, inserts notification row for holder with `ld:called:`, `ld:fu:`, `ld:note:` buttons and logs `operation_type = 'lead_nudge'`.
    - Second nudge within 2 hours -> `429 { error: 'too_many' }`.
    - Plain broker or `team_lead` targeting another broker's lead outside their team -> `403` / `404`.
    - Unassigned or `won`/`lost` lead -> `422`.
    - Agency B lead -> `404`.
- [ ] **Step 2: Run tests to verify failure**
  - Run: `cd WehdatHub-Server; node --experimental-vm-modules node_modules/jest/bin/jest.js tests/api/leads.test.js --runInBand`
  - Expected: FAIL (`404` on `/nudge` & missing buttons assertion).
- [ ] **Step 3: Implement `tellMove` buttons & `nudgeLead` + `/leads/:ref/nudge` route**
  - In `services/leadRules.js` (`tellMove`), attach `buttons: [{ id: \`ld:called:${ref}\`, title: L(to, "📞 كلمته", "📞 Called") }, { id: \`ld:fu:${ref}\`, title: L(to, "📅 متابعة", "📅 Follow-up") }]` on the `to` notification.
  - In `services/leads.js`, implement `nudgeLead(pool, actor, refOrId, { now = new Date() } = {})`:
    - Require `Authz.isManager(actor) || Authz.isTeamLead(actor)` (`{ error: 'forbidden' }`).
    - Load scoped lead via `getLead(pool, actor, refOrId)` (`{ error: 'not_found' }`).
    - Verify `lead.assigned_broker_id` present and `!['won', 'lost'].includes(lead.stage)` (`{ error: 'invalid_update' }`), load active holder broker (`{ error: 'not_found' }` if inactive).
    - Enforce `RateLimit.hit(pool, \`lead_nudge:${lead.id}\`, { limit: 1, windowSec: 7200 })` (`{ error: 'too_many' }` -> `retryAfterSec`).
    - Send notification via `Notifications.notifyBroker(pool, holder, { kind: 'follow_up', dedupeKey: \`lead_nudge:${lead.id}:${Math.floor(now.getTime() / 60000)}\`, ... })` with `ld:called:${ref}`, `ld:fu:${ref}`, `ld:note:${ref}` buttons, and `logOperation(pool, { agency_id: actor.agency_id, broker_id: actor.id, operation_type: 'lead_nudge', status: 'success', metadata: { lead_ref: lead.ref, target_broker_id: holder.id } })`.
  - Register `POST /leads/:ref/nudge` in `api/leads.js`, add `too_many: 429` in `ERRORS`, update `API_CONTRACTS.json` (`node scripts/api-contracts.js`).
- [ ] **Step 4: Run targeted & security/guard tests**
  - Run: `cd WehdatHub-Server; node --experimental-vm-modules node_modules/jest/bin/jest.js tests/api/leads.test.js tests/unit/api-error-words.test.js tests/security/access.test.js tests/contract-guard.test.js --runInBand`
  - Expected: PASS.
- [ ] **Step 5: Commit Task 2**
  - Commit in `WehdatHub-Server`.

---

### Task 3: Deterministic-First `POST /api/v1/assistant/query` & `market: 'resale'` Lock (`WehdatHub-Server`)

**Files:**
- Create: `WehdatHub-Server/domain/assistantRouter.js`
- Create: `WehdatHub-Server/services/assistantQuery.js`
- Create: `WehdatHub-Server/api/assistant.js`
- Modify: `WehdatHub-Server/services/search.js:467-485` (optional `market` filter param)
- Modify: `WehdatHub-Server/api/index.js` (mount `assistant`)
- Modify: `WehdatHub-Server/lib/testRole.js:18` (add `assistant/query` to `VIEW_POST_OPEN`)
- Modify: `WehdatHub-Server/lib/usageLog.js:5-6,47-55` (add `TIMED` entries + allowlisted events/meta)
- Modify: `WehdatHub-Server/tests/security/routes.js:27` (add `"assistant"`)
- Modify: `WehdatHub-Server/API_CONTRACTS.json`
- Test: `WehdatHub-Server/tests/unit/assistant-router.test.js`
- Test: `WehdatHub-Server/tests/api/assistantQuery.test.js`

**Interfaces:**
- Produces (`domain/assistantRouter.js`):
  - `classifyAssistantQuery({ text, mode }): { route: 'unit_search' | 'primary' | 'crm_commissions' | 'crm_leads' | 'crm_broker' | 'crm_sources' | 'crm_leases' | 'crm_brief' | 'clarify', metricHint?: string, brokerQuery?: string, queueHint?: string }`
- Produces (`services/assistantQuery.js`):
  - `query(pool, { AI, actor, text, mode, now }): Promise<{ intent, modeUsed, headline, windowLabel, cards, actions, links, units?, projects?, aiUsed, clarify? }>`
- Produces (`POST /api/v1/assistant/query`): rate-limited via `RateLimit.apiGate`, returns `200 AssistantQueryResponse` or `400/422/429`.

- [ ] **Step 1: Write failing unit & API integration tests**
  - In `tests/unit/assistant-router.test.js`: test pure routing across `mode='auto'`, `'resale'`, `'primary'`, `'reports'` ensuring commissions / silent brokers / waiting > 1h / leases / broker name questions route deterministically to CRM intents, unit queries route to `'unit_search'`, project queries route to `'primary'`, and `"resale"` never yields `'primary'`.
  - In `tests/api/assistantQuery.test.js`:
    - Mock `AI` to throw if called during deterministic CRM queries (`"developer commissions"`, `"who is not updating leads"`, `"waiting over 1h"`) -> asserts `aiUsed: false`, HTTP 200, non-empty `cards[]` & `links[]`, zero AI credit spent.
    - Broker scorecard query by name (`"Ahmed"`): returns broker metrics + `discipline` + `updates` + `missed` + `noNextStep` for manager; refuses/scopes for plain broker (`no agency leak`).
    - Stuck-lead response includes `recommendedBrokers[]` (active, non-away, lowest `open`, excluding current holder) for smart reassign and `nudge` action metadata.
    - `mode: 'resale'` on query matching zero strict units relaxes price/area within `resale` only and excludes `primary` listings; offers Primary pivot link.
    - Respects `ViewGuard` / NCH `testRole` (`viewPostAllowed` returns `true` for `/assistant/query`, `403` on writes).
- [ ] **Step 2: Run tests to verify failure**
  - Run: `cd WehdatHub-Server; node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/assistant-router.test.js tests/api/assistantQuery.test.js --runInBand`
  - Expected: FAIL (`Cannot find module ...`).
- [ ] **Step 3: Implement `domain/assistantRouter.js`, `Search.search` `market` constraint, `services/assistantQuery.js`, `api/assistant.js`, and wire guards/telemetry**
  - In `services/search.js`: accept optional `market = null` on `search()` & apply `if (market) parse.parsed.filters.market = market;` before `Q.classifyIntent` & `runSearch` (leaving omitted callers 100% identical).
  - Write `domain/assistantRouter.js`: zero-DB classifier handling EN + AR + Franco triggers.
  - Write `services/assistantQuery.js`: dispatches deterministic CRM queries (`Commissions.pageCommissions`, `Dash.agencyDashboard`, `Leads.listLeads` (`waiting-over-1h`, `overdue`, `unassigned`), `Intake.listForAgency`, `Leases.list`, `LeadRules.routingList`) behind `Authz` & `Segments.allows(ws, feature)`; runs `Search.search` for resale units (returning serialized `units` + `clear`/`pivot` links); runs `Assistant.ask` + `ProjectSearch.fromQuery` for `primary`.
  - Create `api/assistant.js`, mount in `api/index.js`, update `lib/testRole.js` (`/^\/(ask|search\/voice|assistant\/query)$/`), `tests/security/routes.js`, `lib/usageLog.js` (`APP_EVENTS` + `META_KEYS` + `TIMED` for `/dashboard`, `/today/home`, `/commissions`, `/sources`, `/assistant/query`, `/leads/[^/]+/nudge`), run `node scripts/api-contracts.js`.
- [ ] **Step 4: Run tests and security guards**
  - Run: `cd WehdatHub-Server; node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/assistant-router.test.js tests/api/assistantQuery.test.js tests/security/access.test.js tests/visibility-guard.test.js tests/contract-guard.test.js tests/unit/segments-lint.test.js tests/unit/api-error-words.test.js --runInBand`
  - Expected: PASS.
- [ ] **Step 5: Commit Task 3**
  - Commit in `WehdatHub-Server`.

---

### Task 4: Shared Types & Mobile Dashboard App-Update Discipline UI (`WehdatHub-App`)

**Files:**
- Modify: `WehdatHub-App/packages/shared/src/api.ts:220-260,640-700`
- Modify: `WehdatHub-App/apps/mobile/src/screens/InsightsScreens.tsx:34-120`
- Test: `WehdatHub-App/apps/mobile/__tests__/insights.test.tsx`

**Interfaces:**
- Consumes: Task 1 `/api/v1/dashboard` additive fields & Task 2–3 endpoints.
- Produces (`@wehdathub/shared`):
  - `BrokerDiscipline = 'consistent' | 'lagging' | 'silent'`
  - Extended `DashboardData`: additive `waitingOver1h?`, `disciplineSummary?`, and per-`board[]` row optional `updates?`, `updates48h?`, `activeDays?`, `lastUpdateAt?`, `noNextStep?`, `staleOpen?`, `missed?`, `onTimePct?`, `telegramLinked?`, `discipline?`.
  - `AssistantMode = 'auto' | 'resale' | 'primary' | 'reports'`, `AssistantQueryResponse`, `api.assistantQuery({ q, mode })`, `api.nudgeLead(ref)`.

- [ ] **Step 1: Write failing tests in `apps/mobile/__tests__/insights.test.tsx`**
  - Add test rendering `DashboardScreen` with `waitingOver1h`, `disciplineSummary: { consistent: 2, lagging: 1, silent: 1, totalNoNextStep: 3, totalMissed: 2 }`, and `board[]` items having `updates`, `missed`, `noNextStep`, `discipline: 'silent' | 'lagging' | 'consistent'`, `telegramLinked: false` -> asserts **App Update Discipline** card, ranking toggle for **`Updates`** (`ranking` mode), `UrgencyBadge` tone labels, and legacy `board[]` rows without new fields render gracefully with zero crash.
- [ ] **Step 2: Run tests to verify failure**
  - Run: `cd WehdatHub-App/apps/mobile; pnpm exec jest __tests__/insights.test.tsx`
  - Expected: FAIL (`Property 'updates' does not exist` / missing testIDs).
- [ ] **Step 3: Update `packages/shared/src/api.ts` and `InsightsScreens.tsx`**
  - Add types + `api.nudgeLead` + `api.assistantQuery` cleanly in `packages/shared/src/api.ts`.
  - In `InsightsScreens.tsx`:
    - Add `waitingOver1h` tile under `Now` when `d.waitingOver1h != null`.
    - Add **App Update Discipline** section (using `SectionCard`, `KpiTile`, `UrgencyBadge`) when `d.disciplineSummary` is present.
    - Add `updates` option to `ranking` metric `Chips` (`metric: 'deals' | 'commission' | 'responseMin' | 'updates'`) and display per-broker discipline badge + `updates` / `missed` / `noNextStep` + subtle `"Telegram off"` note on Leaderboard rows when provided (gracefully omitted on legacy servers).
- [ ] **Step 4: Verify typecheck, lint & tests**
  - Run: `cd WehdatHub-App; pnpm typecheck; pnpm lint; pnpm --filter @wehdathub/shared test; cd apps/mobile; pnpm exec jest __tests__/insights.test.tsx`
  - Expected: PASS (`0` TS errors, `0` ESLint errors, all tests green).
- [ ] **Step 5: Commit Task 4**
  - Commit in `WehdatHub-App`.

---

### Task 5: Multiline `VoiceBar`, Auto-Hiding `✨` Trigger & Animated Popover (`WehdatHub-App`)

**Files:**
- Create: `WehdatHub-App/apps/mobile/src/components/ComposerPopover.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/components/VoiceBar.tsx:480-565`
- Modify: `WehdatHub-App/apps/mobile/src/screens/SearchScreen.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/analytics.ts`
- Modify: `WehdatHub-App/apps/mobile/src/usage.ts`
- Test: `WehdatHub-App/apps/mobile/__tests__/VoiceBar.test.tsx` (or `SearchScreen.test.tsx`)

**Interfaces:**
- Produces (`VoiceBar.tsx`): hides start `accessory` automatically when `Boolean(value?.trim())` or `phase !== 'idle'` so input fills 100% width; `multiline`, `submitBehavior="submit"`, dynamic height capped at 3 lines (`maxHeight: 88`).
- Produces (`ComposerPopover.tsx`): spring-animated popover (`ReduceMotion.System`) with `mode` switcher (`auto` / `resale` / `primary` / `reports`), `rights`+`nav`-filtered Role Shortcuts, and Recent 3 queries.

- [ ] **Step 1: Write failing tests in `SearchScreen.test.tsx`**
  - Verify `search-mode-trigger` (`✨` button) renders when input is empty, disappears (`queryByTestId('search-mode-trigger') === null`) when text is typed so `TextInput` keeps full width, tapping `✨` opens `composer-popover` with `Resale` / `Primary` / `Reports` modes & hides disallowed tier shortcuts, locking `Primary` updates placeholder + shows dismissible top `mode-lock-chip`, and cancelling/editing voice transcript logs `voice_transcript_outcome` (`edited` / `cancelled` / `sent_as_is`) without PII.
- [ ] **Step 2: Run tests to verify failure**
  - Run: `cd WehdatHub-App/apps/mobile; pnpm exec jest __tests__/SearchScreen.test.tsx`
  - Expected: FAIL (`Unable to find search-mode-trigger`).
- [ ] **Step 3: Implement `VoiceBar.tsx` multiline + auto-hide `accessory`, `ComposerPopover.tsx`, telemetry, and wire `SearchScreen.tsx`**
  - Update `VoiceBar.tsx` (`multiline`, `submitBehavior="submit"`, dynamic `maxHeight: 88`, render `accessory` only when `phase === 'idle' && !value?.trim()`).
  - Build `ComposerPopover.tsx` reusing `SectionCard` / `Chips` / `HomeRow` styling and `ReduceMotion.System`.
  - Wire mode lock + placeholder + dismissible top chip + contextual `search-clear-chat` button in `SearchScreen.tsx` (ensuring existing `SearchScreen.test.tsx` flows like pressing `search-clear-chat` after search/recent history stay intact without occupying the idle composer bar).
  - Add `track('voice_transcript_outcome', ...)` and assistant telemetry helpers cleanly.
- [ ] **Step 4: Run tests, typecheck & lint**
  - Run: `cd WehdatHub-App; pnpm typecheck; pnpm lint; cd apps/mobile; pnpm exec jest __tests__/SearchScreen.test.tsx`
  - Expected: PASS.
- [ ] **Step 5: Commit Task 5**
  - Commit in `WehdatHub-App`.

---

### Task 6: Option B Assistant Cards, 1-Tap Reassign, Telegram Nudge & Share Summary (`WehdatHub-App`)

**Files:**
- Create: `WehdatHub-App/apps/mobile/src/components/AssistantCards.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/screens/SearchScreen.tsx`
- Test: `WehdatHub-App/apps/mobile/__tests__/AssistantCards.test.tsx`
- Test: `WehdatHub-App/apps/mobile/__tests__/SearchScreen.test.tsx`

**Interfaces:**
- Consumes: `api.assistantQuery`, `api.nudgeLead`, `api.assignLead`, `SectionCard`, `KpiTile`, `UrgencyBadge`, `StatRow`, `HomeRow`.
- Produces (`AssistantCards.tsx`): renders server `AssistantQueryResponse` (`headline`, `windowLabel`, metric tiles, bar breakdown, broker scorecard with `discipline`/`updates`/`missed`, actionable stuck-lead rows with Smart Reassign chips & `🔔 Ask for update` Telegram nudge handling `429` cooldown toast, 1-tap Share summary via `Share.share`, and deep links / Resale-Primary pivot buttons).

- [ ] **Step 1: Write failing tests in `AssistantCards.test.tsx` and `SearchScreen.test.tsx`**
  - Test rendering `broker_scorecard` (shows `updates`, `noNextStep`, `missed`, `discipline` `UrgencyBadge`, link to stuck leads).
  - Test `stuck_leads` card: pressing smart-pick broker chip calls `api.assignLead(ref, brokerId)`; pressing `Ask for update` calls `api.nudgeLead(ref)` and handles `429 too_many` error gracefully with localized toast (`errorText`).
  - Test `Share summary` triggers `Share.share` with non-PII metric text (no client phone).
  - Test `SearchScreen` submitting natural executive/assistant question calls `api.assistantQuery({ q, mode })`, handles offline/legacy fallback cleanly, and `mode='resale'` shows 1-tap Primary pivot when returned.
- [ ] **Step 2: Run tests to verify failure**
  - Run: `cd WehdatHub-App/apps/mobile; pnpm exec jest __tests__/AssistantCards.test.tsx __tests__/SearchScreen.test.tsx`
  - Expected: FAIL (`Cannot find module '../src/components/AssistantCards'`).
- [ ] **Step 3: Implement `AssistantCards.tsx` and wire into `SearchScreen.tsx`**
  - Keep components crisp and themed (`theme.ts` light/dark semantic colors, RTL chevron/flex parity, `tabular-nums`, `FadeIn.duration(180).reduceMotion(ReduceMotion.System)`).
  - In `SearchScreen.tsx`, preserve existing fast offline unit-command intents (`new-lead`, `unit`, `links`, `lead-action`, `reverse`) and route Assistant / locked-mode queries cleanly through `api.assistantQuery({ q, mode })` (with fallback to existing `search`/`ask` if server returns `404` during staged rollouts!).
- [ ] **Step 4: Full Verification Across Both Repos**
  - Run `WehdatHub-App`: `pnpm typecheck; pnpm lint; pnpm test`
  - Run `WehdatHub-Server`: `npm run test:fast` (and `npm run test:ci` before merge)
  - Expected: 100% green across both repos.
- [ ] **Step 5: Commit Task 6**
  - Commit in `WehdatHub-App`.
