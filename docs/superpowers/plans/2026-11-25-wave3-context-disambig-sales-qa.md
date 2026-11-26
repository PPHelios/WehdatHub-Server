# Wave 3: Follow-up Context, Broker Disambiguation, Voice Confirm & Operational Sales Q&A Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable stateful follow-up refinements (*"بس بتوع سارة"*, *"لو زودنا الميزانية ٥٠٠ ألف"*) with clean `clearChat` reset, multi-broker disambiguation, lexical voice confirmation bar, privacy-safe correction analytics, the 3 tightened operational sales Q&A routes (*Offer links opened without follow-up*, *Leads approaching SLA*, *Brokers ranked by no-next-step*), and Wave 3 historical/follow-up acceptance tests.

**Architecture:** `SearchScreen.tsx` tracks `assistantContext` (`{ job, subJob, market, filters, window }`) and resets it on `clearChat`/sign-out/complete new queries. `services/assistantQuery.js` handles contextual merges (rejecting contextless fragments into `clarify`), multi-broker `disambiguate` cards, `openedLinks` offer-link queries grouped by visible lead, strict `lead_rules` SLA deadlines (with separate explicit age view only when rules disabled), and `noNextStep` rankings.

**Tech Stack:** Node 24, Express, Postgres/PGlite (`WehdatHub-Server`), React Native 0.88, TypeScript (`WehdatHub-App`), Jest.

**Spec:** [2026-11-25-search-routing-solo-team-redesign.md](file:///d:/code/WehdatHub/WehdatHub-Server/docs/superpowers/specs/2026-11-25-search-routing-solo-team-redesign.md) (§§2–4 Wave 3)

## Global Constraints

- Preserves unrelated diffs in `WehdatHub-Server`; zero PII/raw text in `usage_events` (`lib/usageLog.js` allowlist + `usage.ts`).
- Every new CRM query scopes by `agency_id`, uses `Vis.leads("l")` / `Vis.units("u")`, and enforces role/team_lead/Solo access boundaries.
- Run `node scripts/api-contracts.js` after extending `POST /api/v1/assistant/query`.

## Review Focus

1. **`clearChat()` & sign-out wipe `assistantContext` completely:** Contextless *"بس بتوع سارة"* returns `clarify` instead of reusing cleared Deals filters (verified in Task 1).
2. **Offer-link opens query groups repeated opens into one visible lead row, shows latest `last_opened_at`, excludes leads with open scheduled follow-ups (`follow_up_status = 'open'`), and labels `"Offer link opened"`** without claiming visitor identity (verified in Task 4).
3. **Approaching SLA stays strictly on `response_due_at` when `lead_rules.enabled = true`** (zero false overnight age alerts when `response_due_at IS NULL`); explicit age queue runs only when `lead_rules.enabled = false` (verified in Task 4).
4. **Telemetry allowlist strips any unknown/PII keys** (`q`, `query`, `name`, `phone`) from `search_corrected`, `route_override`, `voice_edited` (verified in Task 3).
5. **Wave 3 acceptance tests:** Paired contextual *"بس بتوع سارة"* vs fresh search AND historical response-activity query with explicit seeded `lead_events` (`"مين رد على العملاء امبارح؟"`) pass end-to-end (verified in Task 5).

---

### Task 1: Stateful Follow-up Context (`previousContext`) & `clearChat` Reset (Server + App)

**Files:**
- Modify: `WehdatHub-Server/api/assistant.js`, `domain/assistantRouter.js`, `services/assistantQuery.js`, `API_CONTRACTS.json`
- Modify: `WehdatHub-App/packages/shared/src/api.ts`, `apps/mobile/src/screens/SearchScreen.tsx`
- Test: `WehdatHub-Server/tests/api/assistantQuery.test.js`, `WehdatHub-App/apps/mobile/__tests__/SearchScreen.test.tsx`

- [ ] **Step 1: Write failing tests** (*"بس بتوع سارة"* with vs without context; *"لو زودنا الميزانية ٥٠٠ ألف"* with/without search context; `clearChat` wiping context).
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 2: Multi-Match Broker Disambiguation & Lexical Voice Confirm Bar (Server + App)

**Files:**
- Create: `WehdatHub-App/apps/mobile/src/voiceConfirm.ts`
- Modify: `WehdatHub-Server/services/assistantQuery.js`, `WehdatHub-App/apps/mobile/src/components/AssistantCards.tsx`, `screens/SearchScreen.tsx`
- Test: `WehdatHub-Server/tests/api/assistantQuery.test.js`, `WehdatHub-App/apps/mobile/__tests__/SearchScreen.test.tsx`, `AssistantCards.test.tsx`

- [ ] **Step 1: Write failing tests** (two matching brokers -> `disambiguate` chips; voice lexical confirm bar on ambiguous codes / short fragments / conflicting market cues -> editable submit; clean voice transcript runs directly).
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 3: Privacy-Safe Correction & Route-Switch Telemetry (Server + App)

**Files:**
- Modify: `WehdatHub-Server/lib/usageLog.js:5-6`, `WehdatHub-App/apps/mobile/src/usage.ts:10`, `screens/SearchScreen.tsx`, `components/AssistantCards.tsx`
- Test: `WehdatHub-Server/tests/api/usage.test.js`, `WehdatHub-App/apps/mobile/__tests__/usage.test.ts`

- [ ] **Step 1: Write failing tests** (`search_corrected`, `route_override`, `voice_edited` accepted with allowlisted keys only; PII/raw query keys stripped).
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 4: Three Operational Sales Q&A Routes (Server + App)

**Files:**
- Modify: `WehdatHub-Server/domain/assistantRouter.js`, `services/assistantQuery.js`
- Modify: `WehdatHub-App/apps/mobile/src/components/AssistantCards.tsx`
- Test: `WehdatHub-Server/tests/api/assistantQuery.test.js`

- [ ] **Step 1: Write failing tests** for:
  1. `crm_opened_no_followup`: groups `share_links` opens per visible lead (`Vis.leads`), ordered by `MAX(s.last_opened_at) DESC`, excludes `follow_up_status = 'open'`, headline/label reads `"Offer link opened"`.
  2. `crm_approaching_sla`: uses `response_due_at` strictly when `lead_rules.enabled = true`; uses explicit `"Waiting 40–59 min"` age queue only when `lead_rules.enabled = false`.
  3. `crm_stuck_brokers`: ranks active brokers by `noNextStep` open leads + `open` total workload.
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 5: Wave 3 Acceptance Tests + Full Whole-Branch Gate (Both Repos)

- [ ] **Step 1: Automate paired Wave 3 acceptance tests** (contextual *"بس بتوع سارة"* vs contextless `clarify`, and *"مين رد على العملاء امبارح؟"* seeded with real `lead_events` `contacted` history vs *"مين مستني رد من امبارح؟"*).
- [ ] **Step 2: Run full CI offline suites across both repos** (`npm run test:ci`, `node --test`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `git diff --check`).
