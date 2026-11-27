# Search Routing, Release Fixes & Solo/Team Redesign Specification

**Date:** 2026-11-25  
**Repositories:** `WehdatHub-Server`, `WehdatHub-App`  
**Selected Approach:** **Approach 1 — Server-Canonical Routing & Shared Flows**, delivered in **3 sequential waves**.

---

## 1. Intent & Why

Recent changes introduced an interactive voice/text assistant (`SearchScreen` + `ComposerPopover` + `AssistantCards` + `POST /api/v1/assistant/query`), new `More` hubs (`AdminHubScreen`, `ReportsHubScreen`, etc.), and updated Lead, Deals, Commissions, Dashboard, UnitCard, and Credit Rings screens. Code review and architecture audits surfaced four problems:

1. **Release-blocking workflow regressions** in Search (`404`/stale fallback races, missing `>20` Resale continuation/controls, missing Commissions & Deals pagination, concurrent lead-action races, incomplete cache invalidation, and `UnitCard` styling diverging from the rest of the app's card design).
2. **Navigation vs. Permission confusion for Solo & Team workspaces** where `unitRights` (`manager: true`, `agencyOwner: true`) leaks multi-broker/Agency-only views to Solo and Team users, while Solo owners still need **My Stats**, personal report answers, and full personal CRUD (owner through data entry).
3. **Coupled intent vs. market routing, fragile date bounds, and live deal-classification mutability**: `domain/assistantRouter.js` treats installments/delivery as Primary signals, uses fixed presets instead of strict Cairo `[fromInclusive, toExclusive)` intervals, lacks Deals breakdown (`closer` vs `participant`, `market`, canonical `area`), and lacks explicit capability/execution transparency.
4. **Unactionable insights & missing safeguards**: Dashboard urgency KPIs are non-clickable and overlap (`Waiting > 1h` vs `Not contacted`, `Unassigned` under scoped views reads 0), update sorting misleads, Primary Ask duplicates work, Credit Rings show 10/10 before loading, Sources risks losing unsaved ad spend on exit/month change, and voice/follow-ups need disambiguation.

---

## 2. Home Search Command Scope (Final Product Boundary)

App navigation lives in the bottom bar and `More` hubs. Home Search handles **searching & asking questions** plus **lead updates by name/number**:

- **Kept in Home Search:**
  1. **Resale / Inventory Search:** natural unit queries, `resale only` exclusions, unit code text searches, inventory counts (*"كام شقة متاحة عندنا في زايد؟"*), pagination, status chips, Save Search.
  2. **Primary Developer Q&A:** project payment plans, delivery, offers (`AskResults`).
  3. **Live & Historical CRM / Deals / Operational Q&A:** `overdue`, `unassigned`, `uncontacted`, `waiting-over-1h`, `viewings today/tomorrow`, `broker/team activity`, `response time`, `discipline`, `deals`, `commissions`, `win/loss`, `sources`, `leases` + Wave 3 offer-link opens / SLA / stuck brokers.
  4. **Lead updates & status changes by name, phone, or code:** `Move <name/phone/L-ref> to <stage>`, `Add note to <name/phone/L-ref>: <text>`, and direct phone/`L-ref` lead lookup (`SearchLeadAction` / `LeadScreen`).
- **Removed from Home Search:**
  - All app screen & report navigation shortcuts (`Open Settings`, `Saved searches`, `Agency dashboard`, `Broker rankings`, `Team workload`, `Lead sources`, `Win/loss`, `Activity log`, `Compare units`, `Pending deals`, `signed-sources`).
  - Unit Code & Work Queues redirects (`open MIR46`, `missing photos`, `units to check`, `reverse` lead match).
  - Client matching redirect (`find options for <name>`).
  - Side-by-side Dual-Market Comparison (`compare_markets` — dropped as unpredictable across large Resale unit counts vs grouped Primary offers).
- **Also Out of Scope / Dropped:**
  - Lead Profile *"Draft message"* & *"Send a unit"* (already lives on `UnitScreen`).
  - Natural-language property shortlist by lead name.

---

## 3. Permissions, Screens, Records & Actions Matrix

`/api/v1/me` fields govern **discoverability** (`nav`) separately from **record visibility & actions** (`rights` + `workspace` + server authz).

| Role / Tier | Screens in `nav` | Records Visible | Actions Allowed | Personal Report Q&A Behavior |
|---|---|---|---|---|
| **Solo Owner** (`1` seat, `mode: 'solo'`) | `Today`, `Leads`, `Search`, `Units`, `More` (`My Stats`, `Portal` if enabled, `Add teammate / Plan`). Hides `Agency Reports` & `Agency Admin`. | Own units, own leads, own deals, own commissions, owners directory. | Add/edit/delete units, portal enquiries, **Merge/Erase own leads**, deals, commissions. **No Assign** (`members <= 1`). | Can ask personal reports (*my leads, overdue, viewings, my deals, my commissions, My Stats*) via `Auto` (and personal `SearchHome` tips). Multi-broker team queries return a plain message (*"Single-person workspace — showing your own figures"*) with `LeadsList`/`Plan` links. |
| **Team** (`2–14` seats, `mode: 'team'`) | `ReportsHub`: `Dashboard` + `Activity Log` (`WinLoss`/`Sources` only if grandfathered in `nav`). `AdminHub`: `Team` + `Requests` (`members > 1`) + `Portal` (`LeadRules` hidden unless grandfathered). | Scoped by `team_style` (`shared` vs `structured`). `Deals` & `canViewDeal` stay **personal-only for `team_lead` & `broker`**; Managers see all agency deals. | Invite only `inviteRoles` (`broker`, `manager` unless grandfathered). Reassign enabled once `members > 1`. | Managers ask agency/broker/source-count questions (`Sources`/`WinLoss` spend/rate gated by plan); Team Leads see own team only; Brokers see personal queues/deals/viewings only. |
| **Agency** (`15+` / pilot) | Full role-based `nav` (`Dashboard`, `WinLoss`, `Sources`, `ActivityLog`, `Team`, `LeadRules`, `Requests`, `Portal`). | Managers see all; `team_lead` sees own + team (except `Deals`, which stays personal-only); `broker` sees own; `data_entry` units (+ owners if enabled). | Full role permissions (`inviteRoles` includes `team_lead`, `data_entry`). | Full role-scoped Assistant Q&A (`crm_*`). |

---

## 4. Detailed Contracts by Wave

### Wave 1 — Pre-Release Blockers, `UnitCard` Design Alignment & Solo/Team Customization

#### 1.1 `UnitCard` Visual Alignment (`WehdatHub-App/apps/mobile/src/components/UnitCard.tsx`)
- Align `UnitCard` to the app's modern design system (`LeadCard`, `ProjectCardView`, `SectionCard`, `HomeRow`):
  - Use `radius.card` (`16`), `borderWidth: 1`, `borderColor: colors.border`, `backgroundColor: colors.card`, `elev('md')` (matching `SectionCard`/`ProjectCardView`).
  - Replace `padding: 8`, `gap: 10`, raw `Chip` micro-pills, and dark-broken `colors.primary` `"EGP"` with `spacing.md` (`12`) padding/gaps, `Pill` (`tone="primary" | "neutral" | "accent"`) metadata row, `colors.primaryInk` currency + `tabular-nums` price (`Colors.text`), and leading `Chevron` affordance matching `LeadCard` / `HomeRow`.
  - Remove asymmetric EN-vs-AR `arabicRow` / `badgeColumn` hacks so EN and AR share one clean RTL-native card structure (keeping `UNIT_PHOTO_HEIGHT` square thumbnail cleanly framed with `radius.md` and preserving `no-photo-` placeholder box + key testIDs).

#### 1.2 Home Search Cleanup & Safe Request Guards (`SearchScreen.tsx`, `searchCapabilities.ts`, `SearchLeadAction.tsx`)
- Remove `SEARCH_DESTINATIONS`, `dashboard`, `ranking`, `unit`, `unit-work`, `reverse`, `signed-sources`, `find options` (`matching`), and `deals`-redirect regexes from `searchCapabilities.ts` & `SearchScreen.tsx`.
- Keep ONLY:
  1. `readLeadCommand(clean)` (lead stage change + add note by **name, phone number, or `L-` code** — tighten `noteOnly` / `move` parsing so phone numbers & names without `L-` or `العميل` always route cleanly).
  2. Direct `L-` ref / Egyptian phone lead lookup (`^\s*(?:L-\d+|(?:\+?20|0)1[0125]\d{8})\s*$`).
  3. Canonical Search / Assistant flow (`runAssistant(clean, mode)`).
- Guard `runAssistant` (`reqGen === generation.current` captured before `await`), legacy `404`/`501` fallback (`auto` -> `api.search(clean)`, `primary` -> `api.ask(clean)`, `resale` -> `api.search(clean, { market: 'resale' })`), and functional `setRecent` updater against out-of-order completions or `clearChat()`.

#### 1.3 Resale Continuation Contract (`api/search.js`, `services/assistantQuery.js`, `packages/shared/src/api.ts`, `SearchScreen.tsx`)
- Eliminate second-interpretation drift on page 2:
  - When `assistantQuery` (`unit_search`) or `GET /api/v1/search` parses a first page, it returns the sanitized filter token `f` (`SearchLink.encodeFilters`), `marketLock: 'resale' | null`, `counts: { active, sold, archived }`, `guesses`, `unapplied`, `ignoredTerms`, and an optional snapshot IDs key / deterministic filter continuation.
  - Extend `GET /api/v1/search` and `api.search(q, opts)` to accept `{ market?: 'resale' | 'primary', f?: string, sort?: string, status?: UnitStatus, offset?: number, drop?: boolean }`.
  - When `f` is supplied on `offset > 0` or status switch (`Sold` / `Archived`), `GET /api/v1/search` **reuses `SearchLink.decodeFilters(f)` directly via `Search.runSearch`** (skipping `parseRequest` AI/text re-interpretation!), carrying exact `market`, `status`, `sort`, and resolved filters through paging and `SaveSearchButton`.
  - In `SearchScreen.tsx`, hand off `assistantQuery` `unit_search` responses (`items.length > 0 || status === 'ask'`) cleanly into the native `AnimatedFlashList` inventory UI seeded with `f`, `market`, `counts`, `last`, and `extra = []`.

#### 1.4 Pagination for Commissions & Deals (`DealsScreens.tsx`)
- Convert `CommissionsScreen` & `DealsScreen` to `useInfiniteQuery` (`PAGE = 20`) carrying all active filters (`kind`, `filter`/`overdue`, `developerId`, `status`, `period`), automatically resetting page offset on filter changes, reading summary/totals from `pages[0]`, and rendering explicit load-more controls.

#### 1.5 Concurrent Assistant Lead Actions & Real Cache Invalidation (`AssistantCards.tsx`, `SearchScreen.tsx`)
- Track **instant** per-lead in-flight locks using `const inFlightRef = useRef<Map<string, 'assign' | 'nudge'>>(new Map())` alongside `busyRefs` state (preventing double-tap races before the next render).
- On error (including `409 Conflict`), show the error banner directly adjacent to the affected lead item, invalidate `['leads']`, `['lead', ref]`, and keep sibling leads unaffected.
- After reassignment succeeds, invalidate `['leads']`, `['lead', ref]`, `['today']` (covering `['today', 'home', ...]` via prefix), and `['dashboard']`.

#### 1.6 Plan-Aware Hubs, Solo **My Stats**, & Team Customization
- Implement the Permissions Matrix (§3):
  - Extend `useRightsState()` (`rights.ts`) to expose `workspace` & `inviteRoles`.
  - Gate `MoreScreen`, `ReportsHubScreen`, `AdminHubScreen` dynamically via `hasNavApp(nav, ...)`, auto-selecting the first visible tab and omitting `HubTabs` when `<= 1` tab is visible.
  - For **Solo** (`workspace?.mode === 'solo'`): hide `Agency Reports`, add **`My Stats`** (`hub-mystats`) opening `DashboardScreen` personal mode, replace `Agency Admin` with direct **Portal Inquiries** (when in `nav`) + **Add a teammate / Plan**, label Usage `"My plan"`, preserve Solo owner `LeadActions` (Merge/Erase while `canAssign` stays false), simplify `SearchHome` tips to personal shortcuts, and keep Solo personal report Q&A accessible via `Auto` (without multi-broker leaderboards or hidden links in `assistantQuery.js`).
  - For **Team**: filter `InviteScreen` & `TeamScreen` `MemberRole` options strictly by `inviteRoles`.

---

### Wave 2 — Job/Market Router, Historical Deal Snapshots, Strict Dates & UX Polish (#8–#12)

#### 2.1 Job vs. Market Routing (`domain/assistantRouter.js`, `services/assistantQuery.js`)
- Separate `job` (`unit_lookup`, `find_units`, `inventory_count`, `project_info`, `crm_report`, `clarify`) from `market` (`resale`, `primary`, `null`) and `exclusions` (`['primary']`).
- Weak cues (`installments`, `delivery`, `down payment`) stay compatible with Resale (`"ريسيل في مدينتي عليه أقساط متبقية"` -> Resale; `"إيه أنظمة السداد والاستلام في مشروع X؟"` -> Primary project).
- Ambiguous financial queries (`"شقق في زايد بمقدم مليون"` in `auto`) return `clarify` offering **Resale inventory** vs **Developer projects** preserving Zayed + 1M down payment.
- Explicit exclusions (`"مفيش برايمري، ريسيل بس"`) lock `market: 'resale'`.
- CRM prompts while locked in `primary` mode (*"overdue leads"*) return a deliberate `"Open overdue leads?"` mode-switch confirm action instead of forcing Primary Q&A.

#### 2.2 Strict Cairo `[fromInclusive, toExclusive)` Date Contract (`domain/assistantRouter.js`, `services/dashboards.js`, `services/deals.js`, `api/deals.js`, `api/insights.js`)
- Define **one** canonical internal interval `{ from: Date, to: Date, kind, inclusiveEndCairoDate, labelEn, labelAr }` with `from` **inclusive** and `to` **exclusive** in `Africa/Cairo`:
  - **Rolling vs. Calendar weeks:** `"last 2 weeks"` / `"آخر أسبوعين"` = 14 rolling Cairo days ending now (`to = next Cairo midnight` / `now` depending on open/live vs completed); `"this week"` = last 7 rolling Cairo days; `"last week"` = previous completed Mon–Sun Cairo week (matching `dashboards.js:weekStart`).
  - **Inclusive calendar bounds:** `"1–15 November"` / `"من ١ لـ ١٥ نوفمبر"` resolves `[YYYY-11-01 00:00 Cairo, YYYY-11-16 00:00 Cairo)` (start of the following Cairo day).
  - **Omitted year rule:** Resolve to the most recent completed/current occurrence not further than 30 days in the future (or current year for future scheduled queries).
  - **Limits & Precedence:** Cap custom date spans to `730` days (`2` years); explicit `from`/`to` query params always take precedence over legacy `days`/`period`/`report`; cover Cairo midnight & Egypt DST clock shifts in unit tests.

#### 2.3 Historical Deal Snapshots (`market`, `area`) + `Closer` vs `Involved` Split (`WehdatHub-Server`)
- **Database Migration (next migration number + `ENABLE ROW LEVEL SECURITY` preserved + `ARCHITECTURE_MANIFEST.md` + `npm run schema:reference`):**
  - Add nullable snapshot columns to `deals`: `market text CHECK (market IN ('primary', 'resale'))` and `area_key text` / `area_label text`.
  - Populate at deal creation (`Deals.createDeal`) from the linked `listings` (`market`, `inventory_type`, `details->>'catalogue'`) and canonical `match_place('area', ...)` / `district` / `city` / `compound`, AND backfill existing `deals` rows from `listings` + non-cancelled `commissions` (leaving rows with no reliable evidence `NULL` -> explicitly reported as `'unknown'`).
- **Role & Commission Basis (`services/deals.js`, `services/assistantQuery.js`):**
  - Split `brokerRole: 'closer'` (`d.closing_broker_id = $x` — *"Closed by Sara"*) vs `'participant'` (`closing_broker_id = $x` OR `EXISTS deal_splits` — *"Involved in"*). Default to `'closer'` for `"closed by"` questions and explicitly label which definition ran.
  - Distinguish commission figures clearly in headlines/cards: **Total Deal Commission** (`deals.commission_total`), **Broker Split Share** (`deal_splits.amount`), vs **Developer Collected** (`commissions.paid_amount`).
  - Keep `team_lead` and `broker` strictly personal-only on `Deals`; Managers/Owners filter by any broker (`closer`/`participant`), `market`, `area`, `[from, to)`.
  - Return separate `unknownMarketCount` and `unknownAreaCount` counts cleanly, using identical classification in headline, breakdown, and `DealsScreen` drill-through (`Deals` route with `{ from, to, brokerId, brokerRole, market, area }`).

#### 2.4 Executed-Only Interpretation Line & Deliberate Fallback Actions (`services/assistantQuery.js`, `AssistantCards.tsx`, `SearchScreen.tsx`)
- `understood.appliedFilters` records **only** filters actually executed by the destination SQL/search.
- When a critical filter (`market`, `area`, `broker`) cannot execute on a target destination, **do not silently present an all-market/broader total as filtered**; return an explicit `"View all markets"` (or `"Search developer projects"` / `"Open overdue leads"`) deliberate action button before/alongside clear explanation.
- Keep `0 matches` visually distinct from `clarify`. Add **"Change search"** button (`تعديل البحث`) restoring the original query text into the composer.

#### 2.5 Dashboard Actionability & UX Polish (#8–#12)
- **#8 Dashboard Queues & Labels (`InsightsScreens.tsx`, `api/leads.js`):**
  - Make `Waiting > 1h` -> navigate to `LeadsList` with `queue: 'waiting-over-1h'`; `Not contacted` -> `queue: 'uncontacted'`; `Overdue` -> `queue: 'overdue'`; preserving exact `broker` or `team` (`api/leads.js` `team` filter) scope.
  - When scoped to a specific broker or team, **hide `Unassigned`** (since unassigned leads have `assigned_broker_id IS NULL` and would falsely show `0`) OR label it explicitly `"Agency-wide unassigned"` opening the agency-wide `unassigned` queue. Reconcile queue counts cleanly with tapped tiles.
  - Label `Waiting > 1h` as a subset of `Not contacted`; show live snapshot vs period vs 8-week Cairo date ranges (`weeklyRanges`).
- **#9 "Fewest updates" (`InsightsScreens.tsx`):** Rename `updates` sort pill to **"Fewest updates"**, drop `updates48h` fallback so ranking is 100% same-window `updates`, surfacing `noNextStep` open leads alongside lowest activity.
- **#10 Zero-Duplicate Primary Ask (`AskResults.tsx`, `SearchScreen.tsx`):** Seed `AskResults` initial state directly from `assistant.data.projects` + `token`/`logId` (1 query, 1 log).
- **#11 Credit Rings (`SearchCreditRings.tsx`, `SearchScreen.tsx`):** Neutral track when loading/error (never 10/10 green), refresh on `search` completion, accessible balance summary label, clean EOF whitespace.
- **#12 Sources Ad Spend Guard (`DealsScreens.tsx`, `ReportsHubScreen.tsx`):** Protect unsaved `spend` edits across **month switches, tab switches, and back navigation**, disable Save while in-flight, tag saved status to `submittedMonth`, and retain edits if saving fails.

#### 2.6 Wave 2 Acceptance Tests (EN/AR Pairs)
Automate single-turn EN/AR pairs owned by Wave 2 (Resale w/ installments vs Primary payment plan; inventory count vs Deals w/ market+area+closer; overdue developer commissions; explicit exclusions; down-payment clarify; Primary-mode CRM prompt) checking **executed filters + destination**. *(Contextual follow-up & historical response audit pairs are pinned in Wave 3 once those features ship.)*

---

### Wave 3 — Follow-up Context, Broker Disambiguation, Voice Confirm & Operational Sales Q&A

#### 3.1 Stateful Follow-up Context & `clearChat` Reset
- Pass optional `context: { job, subJob, market, filters, window }` on `POST /api/v1/assistant/query` for contextual refinements (*"بس بتوع سارة"*, *"الشهر اللي فات بدل كده"*, *"لو زودنا الميزانية ٥٠٠ ألف"*).
- Without context, *"بس بتوع سارة"* or budget delta prompts `clarify`; `clearChat()` and sign-out wipe `context`.

#### 3.2 Broker Disambiguation & Voice Confirmation + Telemetry
- Multiple active brokers matching `"Sara"` -> return `disambiguate` chooser chips; clear single-turn broker matches scope accurately.
- Lexical client voice confirm bar (ambiguous unit codes, short fragments `< 2` tokens, conflicting market words) with `search_corrected` / `route_override` / `voice_edited` privacy-safe telemetry (`lib/usageLog.js`).

#### 3.3 Operational Sales Q&A (Tightened)
1. **Offer links opened with no scheduled follow-up:** Scoped by `Vis.leads` + role, grouped to **one row per visible lead** (latest `last_opened_at`), requiring `follow_up_status IS DISTINCT FROM 'open'`, labeled honestly **"Offer link opened"** (`رابط عرض اتفتح`).
2. **Leads approaching SLA:** Strictly query `response_due_at` approaching deadline during working hours when `agencies.lead_rules.enabled = true`; provide an explicit labeled *"Waiting 40–59 min"* age view only when `lead_rules.enabled = false` (no silent overnight age fallback).
3. **Brokers with most open leads lacking next step (`noNextStep`):** Ranked active brokers + open workload + drill-through.
