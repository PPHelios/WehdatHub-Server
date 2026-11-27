# Wave 1: Pre-Release Blockers, UnitCard Design & Solo/Team Customization Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align `UnitCard` with the modern app card design, strip unsupported Search navigation/unit-work/client-match redirects (keeping ONLY property search, Primary Q&A, CRM/Deals Q&A, and lead updates/status/lookup by name or number), guarantee lossless Resale page-2 continuation via filter token `f` + `market`, add pagination to Commissions & Deals, harden async/concurrent lead actions, and enforce the Permissions Matrix across Solo & Team workspaces (including Solo **My Stats**).

**Architecture:** `UnitCard.tsx` adopts `radius.card`, `spacing.md`, `elev('md')`, `Pill` metadata, `colors.primaryInk` currency, and consistent EN/AR RTL layout. `SearchScreen.tsx` & `searchCapabilities.ts` remove `SEARCH_DESTINATIONS` / `unit` / `unit-work` / `reverse` / `find options` while preserving `readLeadCommand` (name/phone/`L-` ref) and phone/ref lead lookup, guarded by `generation.current`. `GET /api/v1/search` & `assistantQuery` support `f` filter continuation + `market` + `counts` so page 2+ and status switches reuse the exact initial filters without re-parsing text.

**Tech Stack:** Node 24, Express, Postgres/PGlite (`WehdatHub-Server`), React Native 0.88, TypeScript, TanStack Query v5 (`useInfiniteQuery`), Jest, RNTL (`WehdatHub-App`).

**Spec:** [2026-11-25-search-routing-solo-team-redesign.md](file:///d:/code/WehdatHub/WehdatHub-Server/docs/superpowers/specs/2026-11-25-search-routing-solo-team-redesign.md) (§§2–4 Wave 1)

## Global Constraints

- Preserves unrelated pre-existing diffs in `WehdatHub-Server` (`lib/navSpec.js`, `services/viewings.js`, `web/*`).
- Workspace gates follow `domain/segments.js` + `lib/workspace.js` (`tests/unit/segments-lint.test.js`); UI surfaces check `/api/v1/me` `nav`, `workspace`, `inviteRoles`.
- Zero raw queries/PII in `usage_events` or `operation_logs`; run `node scripts/api-contracts.js` after server API changes.
- Token parity untouched unless matching both repos.

## Review Focus

1. **Dark-mode contrast & bilingual parity on `UnitCard`:** Price & `"EGP"` must use `colors.primaryInk` (readable in dark mode, never `#0F3F34`), `radius.card`, and consistent `Pill` hierarchy across EN and AR without ad-hoc `badgeColumn` asymmetry (verified in Task 1).
2. **Stale `404` fallback after clearing or starting a newer search + phone-based lead updates:** `"Move 01012345678 to viewing"` and `"Add note to Ahmed: ..."`, plus stale `404` rejection from an earlier assistant request, must behave deterministically (verified in Task 2).
3. **Resale page-2 continuation (`f` + `market`) never re-interprets raw text into mixed/wrong results:** Scrolling past item 20 or switching to `Sold` sends `f` + `market: 'resale'` so `api/search.js` decodes the exact first-page filters without calling `parseRequest` again (verified in Tasks 3 & 4).
4. **Immediate synchronous double-tap lock (`useRef`) & `409 Conflict` recovery on assistant lead cards:** Two rapid taps before React re-renders only fire one network request, and `409` displays inline on that lead row and refreshes `['leads']` / `['lead', ref]` (verified in Task 6).
5. **Solo owner keeps Merge/Erase + My Stats + personal reports while Team hides Agency-only tabs & `team_lead`/`data_entry` invites:** Enforced across both App hubs/menus and Server `assistantQuery` (verified in Tasks 7–9).

---

### Task 1: Align `UnitCard` with App Design System (App)

**Files:**
- Modify: `WehdatHub-App/apps/mobile/src/components/UnitCard.tsx:1-108`
- Modify: `WehdatHub-App/apps/mobile/__tests__/unitCard.test.tsx:1-77`

- [ ] **Step 1: Update/add failing tests in `unitCard.test.tsx`**

Assert:
- Outer `Pressable` style uses `radius.card` (`16`) and `colors.card` / `colors.border`.
- Uses `Pill` components (`type-`, `finishing-`, `deal-`, `owner-`, `code-` if shown) and leading/trailing layout consistency across `lang="en"` and `lang="ar"` (no mismatched `badgeColumn` direction hack, no `fontSize: 11` / raw `colors.primary` `"EGP"` in dark mode).
- Keeps `UNIT_PHOTO_HEIGHT`, `no-photo-${unit.code}`, `title-${unit.code}`, `place-${unit.code}` readable in both `light` and `dark` appearances (`colors.primaryInk`).

- [ ] **Step 2: Run test to verify fail**

Run: `pnpm --dir d:\code\WehdatHub\WehdatHub-App --filter @wehdathub/mobile test -- __tests__/unitCard.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Redesign `UnitCard.tsx` to match `LeadCard` / `ProjectCardView` / `SectionCard` design language**

Use `radius.card` (`16`), `spacing.md` (`12`), `elev('md')`, clean photo wrap (`radius.md` = `12`) with `solid` `Pill` deal badge (`Sale`/`Rent`) matching `ProjectCardView` photo badges (or clean row header badge), metadata `Pill`s (`type`, `finishing`, `code`, `mine`), prominent `colors.primaryInk` `tabular-nums` price (`formatEgp` + `EGP`), clean `specs` line, and trailing `Chevron` (`rtl={lang === 'ar'}`) matching `LeadCard` and `HomeRow`.

- [ ] **Step 4: Run test to verify pass**

Run: `pnpm --dir d:\code\WehdatHub\WehdatHub-App --filter @wehdathub/mobile test -- __tests__/unitCard.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

---

### Task 2: Strip Non-Search Shortcuts, Keep Only Lead Updates/Lookup by Name/Phone/Ref & Add Async Guards (App)

**Files:**
- Modify: `WehdatHub-App/apps/mobile/src/searchCapabilities.ts`
- Modify: `WehdatHub-App/apps/mobile/src/components/SearchLeadAction.tsx:25-50`
- Modify: `WehdatHub-App/apps/mobile/src/screens/SearchScreen.tsx:61-66,192-229,269-353`
- Test: `WehdatHub-App/apps/mobile/__tests__/SearchScreen.test.tsx`, `searchCapabilities.test.ts`, `searchLeadAction.test.ts`

- [ ] **Step 1: Write failing tests**

1. `searchCapabilities.test.ts`: `"Open Settings"`, `"Saved searches"`, `"Agency dashboard"`, `"Lead sources"`, `"Win/loss"`, `"Activity log"`, `"open MIR46"`, `"missing photos"`, `"who might want MIR46"`, `"find options for Sara"` return `{ kind: 'search' }` (never navigation/redirect intents), while `"01012345678"` and `"L-0042"` still resolve to `{ kind: 'leads', filters: { lookup } }`.
2. `searchLeadAction.test.ts`: `"Move 01012345678 to viewing"`, `"انقل أحمد إلى تفاوض"`, `"Add note to 01012345678: wants Zayed"` parse cleanly into `Command`.
3. `SearchScreen.test.tsx`: reverse-order stale `404` fallback from request A does NOT overwrite request B or `recent`; `404` fallback in `auto` mode routes `L-0042` / `overdue` cleanly or runs `api.search(clean)` for search queries.

- [ ] **Step 2: Run tests to verify fail -> Step 3: Implement cleanup & guards -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 3: Filter-Token Continuation (`f`), `market` Lock & Status `counts` on Server Search (Server)

**Files:**
- Modify: `WehdatHub-Server/api/search.js:23-76`
- Modify: `WehdatHub-Server/services/search.js:467-487` (support `parsedOverride` / decoded `f` continuation without re-running AI/parser)
- Modify: `WehdatHub-Server/services/assistantQuery.js:714-763`
- Modify: `WehdatHub-Server/API_CONTRACTS.json`
- Test: `WehdatHub-Server/tests/api/assistantQuery.test.js`, `tests/api/search.test.js`

- [ ] **Step 1: Write failing tests**

1. Assistant `unit_search` (`total: 25`, mixed primary + resale units, `"شقق ريسيل في زايد"` in `auto` OR any query in `resale` mode) returns `units.f`, `units.counts: { active, sold, archived }`, `units.marketLock: 'resale'`, `units.total: 25`, `units.items.length === 20`.
2. Calling `GET /api/v1/search?q=ignored&f=<token>&market=resale&status=active&offset=20` skips text parsing (`AI.ask` / `parseRequest` NOT called!), uses decoded filters + `market: 'resale'`, returns items `21..25` with zero Primary leakage.
3. Invalid/tampered `f` safely falls back cleanly or returns 400/re-parses safely without crash.

- [ ] **Step 2: Run tests to verify fail -> Step 3: Implement continuation + counts -> Step 4: Run `node scripts/api-contracts.js` & Jest -> Step 5: Commit**

---

### Task 4: Seamless Assistant Resale Continuation in App `SearchScreen` (App)

**Files:**
- Modify: `WehdatHub-App/packages/shared/src/api.ts` (`SearchResult.marketLock`, `api.search` `{ market, f }`)
- Modify: `WehdatHub-App/apps/mobile/src/screens/SearchScreen.tsx`
- Test: `WehdatHub-App/apps/mobile/__tests__/SearchScreen.test.tsx`

- [ ] **Step 1: Write failing tests** (Assistant returns 25 Resale units -> shows `SaveSearchButton`, status chips `Active (25) / Sold (3) / Archived (1)`, `onEndReached` sends `f` + `market: 'resale'` + `offset: 20`; toggling `Sold` sends `f` + `market: 'resale'` + `status: 'sold'`; `0` matches keeps `Search Primary projects instead?`).
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 5: Commissions & Deals Load-More Pagination (App)

**Files:**
- Modify: `WehdatHub-App/apps/mobile/src/screens/DealsScreens.tsx:48-196`
- Test: `WehdatHub-App/apps/mobile/__tests__/deals.test.tsx`

- [ ] **Step 1: Write failing tests** (>20 Commissions with `dev-1` + `overdue: true` loads page 1 -> filter change resets to page 0; Deals `more: true` loads page 1).
- [ ] **Step 2: Verify fail -> Step 3: Convert to `useInfiniteQuery` -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 6: Immediate Per-Lead Action Lock (`useRef` + `busyRefs`), `409` Inline Recovery & Correct Cache Keys (App)

**Files:**
- Modify: `WehdatHub-App/apps/mobile/src/components/AssistantCards.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/screens/SearchScreen.tsx:510-521`
- Test: `WehdatHub-App/apps/mobile/__tests__/AssistantCards.test.tsx`, `SearchScreen.test.tsx`

- [ ] **Step 1: Write failing tests**

1. Rapid double-tap on `assign` / `nudge` before render completes fires only 1 API call via synchronous `useRef` guard, while tapping Lead B concurrently proceeds independently without clearing Lead A's busy marker.
2. `409 Conflict` / API error renders an inline error next to that specific lead row and refreshes `['leads']`, `['lead', ref]`, without clearing sibling leads' states.
3. Successful assignment in `SearchScreen` invalidates `['leads']`, `['lead', ref]`, `['today']` (covering `['today', 'home', ...]`), and `['dashboard']`.

- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 7: Permissions Matrix Across Hubs, Solo **My Stats**, Invite Roles & LeadActions (App)

**Files:**
- Modify: `WehdatHub-App/apps/mobile/src/rights.ts` (`workspace`, `inviteRoles`)
- Modify: `WehdatHub-App/apps/mobile/src/screens/MoreScreen.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/screens/ReportsHubScreen.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/screens/AdminHubScreen.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/screens/SettingsHubScreen.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/screens/InviteScreen.tsx`, `TeamScreen.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/components/ComposerPopover.tsx`, `SearchHome.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/screens/LeadScreen.tsx:164` (`rights.team || rights.agencyOwner` for `LeadActions` Merge/Erase, keeping `canAssign` off for Solo)
- Test: `WehdatHub-App/apps/mobile/__tests__/more.test.tsx`, `rights.test.tsx`, `memberRole.test.tsx`, `LeadScreen.test.tsx`, `SearchScreen.test.tsx`

- [ ] **Step 1: Write failing tests covering Solo, Team, Grandfathered Team, and Agency** (confirming Solo gets **`My Stats`** + personal CRM shortcuts + Lead Merge/Erase + `Portal`, hiding `Agency Reports`/`Agency Admin`/team-comparison prompts; Team hides `Lead Rules`, `Win & Loss`/`Sources` unless in `nav`, and `team_lead`/`data_entry` invites unless in `inviteRoles`).
- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify pass -> Step 5: Commit**

---

### Task 8: Server Solo Personal Report Scoping in `assistantQuery` (Server)

**Files:**
- Modify: `WehdatHub-Server/services/assistantQuery.js`
- Test: `WehdatHub-Server/tests/api/assistantQuery.test.js`

- [ ] **Step 1: Write failing tests**

1. Solo owner asking personal CRM/report queries (*"overdue follow-ups"*, *"my viewings today"*, *"developer commissions"*, *"my summary"*) gets accurate personal metrics + `LeadsList`/`Commissions` links.
2. Solo owner asking team-wide queries (*"who is not updating?"*, *"Omar's team"*) gets a clear personal summary + note (*"Single-person workspace — showing your own figures"*) with zero `Dashboard`/`Team` links.

- [ ] **Step 2: Verify fail -> Step 3: Implement -> Step 4: Verify `assistantQuery.test.js` & `segments-lint.test.js` pass -> Step 5: Commit**

---

### Task 9: Wave 1 End-to-End Verification Gate (Both Repos)

- Run `WehdatHub-Server`: `node scripts/api-contracts.js`, `git diff --check`, `node --test tests/e2e.test.js tests/parsers/regression.test.js`, `npm run test:fast`.
- Run `WehdatHub-App`: `git diff --check`, `pnpm typecheck`, `pnpm lint`, `pnpm test`.
