# Wave 2: Job/Market Router, Deal Snapshots, Strict Cairo Dates & UX Polish Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Job from Market (removing comparison mode cleanly), standardize flexible dates on one strict `[fromInclusive, toExclusive)` Cairo interval engine, snapshot `market` + canonical `area` on `deals` (with `closer` vs `participant` split & commission basis clarity), enforce executed-only Interpretation Line + deliberate fallback buttons, deliver UX items #8–#12 (with real dashboard queue IDs & scoped `Unassigned` handling + exit-safe Sources ad spend), and automate Wave 2's single-turn EN/AR test pairs.

**Architecture:** `db/migrations/` adds nullable `market` & `area_key` / `area_label` snapshot columns on `deals` populated at close and backfilled safely. `domain/assistantRouter.js` outputs `{ job, subJob, market, exclusions, filters, window: { from, to, kind, inclusiveEndCairoDate, labelEn, labelAr } }` validated by explicit range/DST/week-start rules. `AssistantQueryResponse.understood.appliedFilters` reflects only actually executed backend filters, offering deliberate fallback actions when a key scope filter isn't supported.

**Tech Stack:** Node 24, Express, Postgres/PGlite migration (`WehdatHub-Server`), React Native 0.88, TypeScript, TanStack Query v5 (`WehdatHub-App`), Jest.

**Spec:** [2026-11-25-search-routing-solo-team-redesign.md](file:///d:/code/WehdatHub/WehdatHub-Server/docs/superpowers/specs/2026-11-25-search-routing-solo-team-redesign.md) (§§2–4 Wave 2)

## Global Constraints

- New DB migration -> next migration number, add filename to `ARCHITECTURE_MANIFEST.md`, run `npm run schema:reference`, keep `ENABLE ROW LEVEL SECURITY` on `deals` untouched, zero `anon`/`authenticated` grants (`tests/unit/public-api-lockdown.test.js`).
- Keep `team_lead` and `broker` strictly personal-only on `Deals` (`canViewDeal`, `listDeals`).
- Preserves unrelated diffs in `WehdatHub-Server`; run `node scripts/api-contracts.js` after API updates.

## Review Focus

1. **Historical deal snapshot immutability & unknown separation:** Deleting or editing a unit after closing must NOT change past month `market` or `area` deal totals, and `unknownMarketCount` must remain separate from `unknownAreaCount` (verified in Task 2 & Task 4).
2. **`"Closed by Sara"` vs `"Involved in by Sara"` & zero double-counting:** A deal closed by Omar with a 30% split to Sara must NOT appear under `"Closed by Sara"` and must NOT double-count deal totals across a team breakdown (verified in Task 4).
3. **Cairo midnight, DST transition & inclusive range ends (`1–15 Nov`):** Must resolve `[2026-11-01 00:00 Cairo, 2026-11-16 00:00 Cairo)` cleanly across Egypt's spring/autumn DST boundaries; `from`/`to` overrides legacy `days`/`period` and rejects >730-day spans cleanly (verified in Task 1).
4. **Dashboard `Unassigned` under broker/team scope & real queue IDs:** `Waiting > 1h` opens `waiting-over-1h`, `Not contacted` opens `uncontacted` preserving scope, while `Unassigned` hides or labels itself `"Agency-wide unassigned"` under broker/team scope rather than misleadingly showing `0` (verified in Task 6).
5. **Ad spend protection across tab switches & failed saves:** Switching ReportsHub tabs or navigating back with unsaved spend prompts/preserves draft, disables duplicate Save taps, and retains edits if API fails (verified in Task 8).

---

### Task 1: Strict Cairo `[from, to)` Interval Parser (Server)

**Files:**
- Modify: `WehdatHub-Server/domain/assistantRouter.js`
- Test: `WehdatHub-Server/tests/unit/assistant-router.test.js`

- [ ] **Step 1: Write failing tests** covering:
  - Inclusive end date phrase (`"1-15 Nov"` / `"من ١ لـ ١٥ نوفمبر"` -> `to = Nov 16 00:00 Cairo`).
  - Rolling durations (`last 3 days`, `last 2 weeks` = 14 rolling Cairo days, `last 48 hours`) vs completed Mon–Sun week (`last week`).
  - Open anchor (`since yesterday` / `من امبارح` -> `[yesterday 00:00 Cairo, now]`).
  - Omitted year rule, Cairo midnight boundary, and Egypt DST transition day (`24h` vs `23h`/`25h` local midnight integrity).
- [ ] **Step 2: Run Jest to verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 2: `deals` Historical Snapshot Columns (`market`, `area_key`, `area_label`) Migration & Write Path (Server)

**Files:**
- Create: `WehdatHub-Server/db/migrations/<NEXT>_deals_market_area_snapshot.sql`
- Modify: `WehdatHub-Server/ARCHITECTURE_MANIFEST.md`
- Modify: `WehdatHub-Server/SCHEMA_REFERENCE.sql` (via `npm run schema:reference`)
- Modify: `WehdatHub-Server/services/deals.js` (`createDeal`, `prepare`)
- Test: `WehdatHub-Server/tests/unit/schema-reference.test.js`, `tests/unit/public-api-lockdown.test.js`, `tests/api/deal-search-report.test.js`

- [ ] **Step 1: Write failing test** verifying `Deals.createDeal` snapshots `market` (`'primary'` | `'resale'` | `null`) and canonical `area_key` / `area_label` on `deals` from the linked unit at closing time, and subsequent unit deletion (`listing_id` -> `NULL`) leaves deal `market` & `area` intact.
- [ ] **Step 2: Run Jest to verify fail**
- [ ] **Step 3: Author next migration** adding nullable `market text CHECK (market IN ('primary','resale'))`, `area_key text`, `area_label text` + indexes on `deals`, backfilling existing rows safely from `listings` (`market`, `inventory_type`, `details->>'catalogue'`, `match_place('area', ...)`) + non-cancelled `commissions`; update `Deals.createDeal`; update `ARCHITECTURE_MANIFEST.md`; run `npm run schema:reference`.
- [ ] **Step 4: Verify migration & schema tests pass -> Step 5: Commit**

---

### Task 3: Decoupled Job/Market Router without Comparison Mode (Server)

**Files:**
- Modify: `WehdatHub-Server/domain/assistantRouter.js`
- Test: `WehdatHub-Server/tests/unit/assistant-router.test.js`

- [ ] **Step 1: Write failing tests** verifying:
  - Weak cues (`installments`, `delivery`, `down payment`) don't hijack Resale units (`"ريسيل في مدينتي عليه أقساط متبقية"` -> Resale `find_units`; `"إيه أنظمة السداد والاستلام في مشروع X؟"` -> Primary `project_info`).
  - Explicit exclusions (`"مفيش برايمري، ريسيل بس"`) set `market: 'resale'`, `exclusions: ['primary']`.
  - Inventory availability count (`"كام شقة متاحة عندنا في زايد؟"`) -> `job: 'inventory_count'`.
  - Ambiguous financial query (`"شقق في زايد بمقدم مليون"` in `auto`) -> `clarify` preserving filters (`market_choice`).
  - Primary mode + CRM intent (`"overdue leads"`) -> `clarify` (`switch_mode_reports`).
  - Note: explicit `compare_markets` is NOT added; dual cues clarify (`Resale` or `Primary`) cleanly.
- [ ] **Step 2: Verify fail -> Step 3: Refactor `classifyAssistantQuery` -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 4: Expanded Deals Reporting (`closer` vs `participant`, Commission Basis, `[from, to)`, `unknown*Count`) & `crm_deals` Handler (Server)

**Files:**
- Modify: `WehdatHub-Server/services/deals.js` (`listDeals`, `dealsSummary`), `api/deals.js`, `services/dashboards.js` (`weeklyRanges`, custom `from`/`to`), `api/insights.js`, `services/assistantQuery.js`, `API_CONTRACTS.json`
- Test: `WehdatHub-Server/tests/api/deal-search-report.test.js`, `tests/api/assistantQuery.test.js`, `tests/api/ownersApi.test.js`

- [ ] **Step 1: Write failing tests** for:
  - `brokerRole: 'closer'` (`closing_broker_id`) vs `'participant'` (closer OR `deal_splits`), never double-counting split rows; labeled response clarifying deal commission vs broker share vs collected.
  - Snapshot `market` + `area` filtering returning separate `unknownMarketCount` & `unknownAreaCount`.
  - `[from, to)` validation (rejects `>730` days, takes precedence over `days`/`period`) and personal-only enforcement for `team_lead` & `broker`.
  - `crm_commissions` overdue specificity + link `{ screen: 'Commissions', params: { kind: 'developers', overdue: true } }`.
  - `understood.appliedFilters` reflecting ONLY executed SQL filters + explicit `"View all markets?"` prompt action when a required key filter isn't supported.
- [ ] **Step 2: Verify fail -> Step 3: Implement & update `API_CONTRACTS.json` -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 5: Executed-Only Interpretation Line, Deliberate Fallback Actions, `"Change Search"` & Deals Drill-Through (App)

**Files:**
- Modify: `WehdatHub-App/packages/shared/src/api.ts`, `apps/mobile/src/navigation.tsx`, `apps/mobile/src/screens/DealsScreens.tsx`, `apps/mobile/src/components/AssistantCards.tsx`, `apps/mobile/src/screens/SearchScreen.tsx`
- Test: `WehdatHub-App/apps/mobile/__tests__/AssistantCards.test.tsx`, `SearchScreen.test.tsx`, `deals.test.tsx`

- [ ] **Step 1: Write failing tests** for executed `understood.appliedFilters` line, deliberate `"View all markets"` / `"Search developer projects"` fallback action chips, `"Change search"` restoring original query & composer focus, distinct `0 matches` vs `clarify`, and `DealsScreen` filter chips (`from`, `to`, `brokerId`, `brokerRole`, `market`, `area`).
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 6: Dashboard Actionable Queues (`waiting-over-1h`, `uncontacted`, `overdue`), Scoped `Unassigned`, `weeklyRanges` & `"Fewest Updates"` (Server + App)

**Files:**
- Modify: `WehdatHub-Server/api/leads.js`, `services/leads.js`, `API_CONTRACTS.json` (`team` filter on `GET /api/v1/leads`)
- Modify: `WehdatHub-App/apps/mobile/src/navigation.tsx`, `components/SectionCard.tsx`, `components/SearchLeads.tsx`, `screens/InsightsScreens.tsx`
- Test: `WehdatHub-Server/tests/api/leads.test.js`, `WehdatHub-App/apps/mobile/__tests__/insights.test.tsx`

- [ ] **Step 1: Write failing tests** checking `waiting-over-1h` vs `uncontacted` vs `overdue` drill-through preserving `broker`/`team` scope, hiding/labeling `Unassigned` when scoped to a broker or team, `weeklyRanges` date strings, `"Fewest updates"` sort label, and dropping `updates48h` fallback.
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 7: Seed `AskResults` Without Duplicate Request (#10) & Fix `SearchCreditRings` (#11) (App)

**Files:**
- Modify: `WehdatHub-App/apps/mobile/src/components/AskResults.tsx`, `screens/SearchScreen.tsx`, `components/SearchCreditRings.tsx` (strip trailing EOF blank line)
- Test: `WehdatHub-App/apps/mobile/__tests__/SearchScreen.test.tsx`, `askResults.test.tsx`

- [ ] **Step 1: Write failing tests** (assistant project results seed `AskResults` with 0 extra page-1 requests; `SearchCreditRings` shows neutral track while loading/error, exposes balance `accessibilityLabel`, refreshes on `search` completion).
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass + `git diff --check` -> Step 5: Commit**

---

### Task 8: Sources Ad Spend Protection Across Month Switches, Tab Switches, Exits & Failed Saves (#12) (App)

**Files:**
- Modify: `WehdatHub-App/apps/mobile/src/screens/DealsScreens.tsx`, `screens/ReportsHubScreen.tsx`
- Test: `WehdatHub-App/apps/mobile/__tests__/deals.test.tsx`

- [ ] **Step 1: Write failing tests** covering unsaved warning on month switch, hub-tab switch / navigation exit (`beforeRemove`), disabled save button while pending, failed save retaining draft input, and `submittedMonth`-scoped confirmation message.
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 9: Wave 2 Single-Turn Paired EN/AR Routing & Capability Tests + Full Verification Gate

**Files:**
- Create: `WehdatHub-Server/tests/unit/assistant-routing-pairs.test.js`
- Modify: `WehdatHub-App/apps/mobile/__tests__/SearchScreen.test.tsx`

- [ ] **Step 1: Automate all Wave 2 single-turn EN/AR pairs** (Resale w/ installments vs Primary payment plan; inventory count vs Deals w/ market+area+closer; overdue developer commissions; explicit exclusions; down-payment clarify; Primary-mode CRM prompt; live `"since yesterday"` waiting queue) verifying executed filters + destination.
- [ ] **Step 2: Run full verification across both repos** (`npm run test:fast`, `node --test`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `git diff --check`).
