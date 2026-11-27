# Solo Broker Self-Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable solo Egyptian real-estate brokers to self-onboard directly inside the mobile app with zero sales involvement, using Telegram-first verification (with a free user-initiated WhatsApp fallback), a 3-step Home Starter Card, and platform-compliant Trial & Plans visibility.

**Architecture:** The server (`WehdatHub-Server`) adds a solo self-serve signup endpoint (`POST /api/v1/auth/signup`) that creates a pending solo workspace and issues a one-time verification token for either Telegram (`t.me/<bot>?start=...`) or user-initiated WhatsApp (`wa.me/<number>?text=...`), activating the 14-day trial and sending the 6-digit login code upon first contact. The mobile app (`WehdatHub-App`) updates `LoginScreen` with the dual Sign-In / Start Free Trial flow, adds a dismissible 3-step `StarterCard` and calm `Trial · Xd` pill on `SearchHome`, enhances `AddUnitScreen` for first-unit momentum, and upgrades `UsageScreen` with trial/bundle breakdowns and an iOS read-only billing guard.

**Tech Stack:** Node.js 24, Express, PostgreSQL / PGlite (`node:test` + Jest), React Native 0.88, TypeScript, `@wehdathub/shared` (Vitest + Jest).

**Spec:** [2026-11-26-solo-self-onboarding-design.md](file:///d:/code/WehdatHub/WehdatHub-Server/docs/superpowers/specs/2026-11-26-solo-self-onboarding-design.md)

## Global Constraints
- Multi-tenant by `agency_id`; every query scoped to `agency_id`.
- No paid SMS OTP; WhatsApp fallback must be user-initiated (broker sends first) so the OTP reply falls inside the free 24-hour customer-service window.
- Phone numbers normalize via `domain/phone.js` (`Phone.normalizePhone` / `Phone.isEgyptMobile`).
- Plan/tier checks use `domain/segments.js` and `lib/workspace.js` (`allows(ws, feature)`), never direct `plan.id` checks.
- No runtime disk writes; all state in Postgres.
- iOS App Store compliance: `Platform.OS === 'ios'` in `WehdatHub-App` must never render payment buttons, payment references, or clickable external checkout links—only informational plan/usage views plus a neutral web-management note.
- Both `ar` (default before sign-in) and `en` copy must be provided in `apps/mobile/src/i18n.ts`.

## Review Focus
- **Already-registered phone on signup:** Submitting a phone that already belongs to an active broker must return `phone_taken` cleanly without leaking account details or creating duplicate agencies.
- **WhatsApp phone mismatch on fallback:** If a user opens the pre-filled WhatsApp link from a *different* phone number than the one they typed in signup, the server must reject activation and ask them to message from the registered number.
- **Repeated / expired verification link:** Tapping an already-used or expired Telegram/WhatsApp verification token must fail gracefully with a clear bilingual prompt to request a new one.
- **iOS billing leak:** On `Platform.OS === 'ios'`, `UsageScreen` must hide `pay-to-card` and `paymentChoices` buttons even if the API returns them.
- **Starter Card persistence & dismissal:** Completing all 3 steps or tapping Dismiss must keep the `StarterCard` hidden across app restarts without extra server round-trips failing offline.

---

### Task 1: Server — Solo Self-Serve Signup & Verification Token Service (`WehdatHub-Server`)

**Files:**
- Modify: `WehdatHub-Server/services/signup.js`
- Test: `WehdatHub-Server/tests/unit/solo-signup.test.js`

**Interfaces:**
- Consumes: `Phone.normalizePhone`, `Phone.isEgyptMobile`, `Plans.TRIAL`, `TgLink.issueLinkToken`, `TgLink.startLink`, `WebAuth.issueLoginCode`
- Produces:
  - `Signup.submitSolo(pool, { name, phone, lang, channel }, { now, username, waNumber })` → `{ ok: true, agency, broker, channel: 'telegram' | 'whatsapp', verifyUrl }` or `{ error: 'closed' | 'name' | 'phone' | 'phone_taken' | 'channel_unavailable' }`
  - `Signup.activatePendingSolo(pool, brokerId, { now })` → `{ ok: true, agency, broker, loginCode }` or `{ error: 'not_pending' }`

- [ ] **Step 1: Write the failing test**
  Create `WehdatHub-Server/tests/unit/solo-signup.test.js` testing:
  - `submitSolo` creates a pending solo agency (`name` derived from broker name, `plan = 'trial'`, `approval = 'pending'`) and inactive owner broker (`is_active = false`), returning a Telegram `verifyUrl` when `channel === 'telegram'` and a `wa.me` `verifyUrl` when `channel === 'whatsapp'`.
  - `submitSolo` returns `{ error: 'phone_taken' }` for an existing phone number.
  - `activatePendingSolo` flips `approval = 'approved'`, sets `trial_ends_at` to `now + 14 days`, sets `is_active = true`, and returns a 6-digit `loginCode`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `cd WehdatHub-Server && node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/solo-signup.test.js --runInBand`
  Expected: FAIL (`Signup.submitSolo is not a function`).

- [ ] **Step 3: Implement `submitSolo` and `activatePendingSolo` in `WehdatHub-Server/services/signup.js`**
  - Keep `submitSolo` scoped to solo trials (`Plans.TRIAL.plan`), auto-naming the agency `${name} (Solo)` (or `${name}`), validating `name` and Egyptian mobile, and issuing either a `TgLink` token URL or a `wa.me/<waNumber>?text=VERIFY%20<token>` URL (storing a short-lived verification token in `broker_sessions` or `tg_link_tokens`).
  - Implement `activatePendingSolo` inside `withTransaction`, clearing `planGuard.forget(agencyId)` and issuing a 6-digit login code via `WebAuth.issueLoginCode`.

- [ ] **Step 4: Run test to verify it passes**
  Run: `cd WehdatHub-Server && node --experimental-vm-modules node_modules/jest.js tests/unit/solo-signup.test.js --runInBand`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git -C WehdatHub-Server add services/signup.js tests/unit/solo-signup.test.js && git -C WehdatHub-Server commit -m "feat: add solo self-serve signup and activation service"`

---

### Task 2: Server — `POST /api/v1/auth/signup` & WhatsApp Send-First Verification (`WehdatHub-Server`)

**Files:**
- Modify: `WehdatHub-Server/api/auth.js`
- Modify: `WehdatHub-Server/lib/waOwnerOnly.js` (allow `VERIFY <token>` from pending solo numbers)
- Modify: `WehdatHub-Server/routes/dispatch.js` (handle `VERIFY <token>` inbound WhatsApp & Telegram `/start` pending solo activation)
- Test: `WehdatHub-Server/tests/unit/api-solo-signup.test.js`

**Interfaces:**
- Consumes: `Signup.submitSolo`, `Signup.activatePendingSolo`, `RateLimit.hit`
- Produces: `POST /api/v1/auth/signup` returning `200 { ok: true, channel, verifyUrl, codeMinutes }` or `409 { error: 'phone_taken' }` / `422 { error: 'name' | 'phone' }` / `429 { error: 'too_many' }`

- [ ] **Step 1: Write the failing test**
  Create `WehdatHub-Server/tests/unit/api-solo-signup.test.js` testing:
  - `POST /api/v1/auth/signup` with valid `{ name, phone, channel: 'telegram' }` returns `{ ok: true, channel: 'telegram', verifyUrl }`.
  - `POST /api/v1/auth/signup` with invalid phone returns `422`.
  - Inbound WhatsApp message `VERIFY <token>` from the matching phone activates the pending solo broker and replies with the 6-digit code; inbound from a *mismatched* phone does not activate and returns a mismatch notice.

- [ ] **Step 2: Run test to verify it fails**
  Run: `cd WehdatHub-Server && node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/api-solo-signup.test.js --runInBand`
  Expected: FAIL (404 on `/api/v1/auth/signup`).

- [ ] **Step 3: Wire `POST /api/v1/auth/signup` and inbound `VERIFY <token>` handling**
  - Add rate-limited `POST /api/v1/auth/signup` in `api/auth.js`.
  - In `lib/waOwnerOnly.js` and `routes/dispatch.js`, allow `VERIFY <token>` messages from unregistered/pending numbers when a matching pending solo token exists, verify sender phone === pending broker phone, call `Signup.activatePendingSolo`, and reply with the 6-digit login code.
  - Ensure Telegram `/start <token>` for a pending solo broker activates via `Signup.activatePendingSolo` and sends the 6-digit login code + welcome tip.

- [ ] **Step 4: Run test to verify it passes**
  Run: `cd WehdatHub-Server && node --experimental-vm-modules node_modules/jest/bin/jest.js tests/unit/api-solo-signup.test.js --runInBand`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git -C WehdatHub-Server add api/auth.js lib/waOwnerOnly.js routes/dispatch.js tests/unit/api-solo-signup.test.js && git -C WehdatHub-Server commit -m "feat: add mobile solo signup endpoint and verification handlers"`

---

### Task 3: Server — Onboarding Progress Fields on `/api/v1/me` or `/api/v1/today` (`WehdatHub-Server`)

**Files:**
- Modify: `WehdatHub-Server/api/today.js` (or `api/auth.js` `/me`)
- Test: `WehdatHub-Server/tests/unit/onboarding-progress.test.js`

**Interfaces:**
- Produces: `onboarding: { hasUnit: boolean, hasSharedLink: boolean, telegramConnected: boolean }` on `/api/v1/today` (or `/api/v1/me`).

- [ ] **Step 1: Write the failing test**
  Assert that `/api/v1/today` returns `onboarding: { hasUnit: false, hasSharedLink: false, telegramConnected: false }` for a newly activated WhatsApp-verified solo broker, and flips `hasUnit: true` after creating a listing.

- [ ] **Step 2: Run test to verify it fails**
  Expected: FAIL (`onboarding` undefined).

- [ ] **Step 3: Add lightweight `onboarding` status query in `api/today.js`**
  Check `EXISTS (SELECT 1 FROM listings WHERE agency_id = $1)`, `telegram_chat_id IS NOT NULL`, and client-link share event / `sent_links` existence.

- [ ] **Step 4: Run test to verify it passes**
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git -C WehdatHub-Server add api/today.js tests/unit/onboarding-progress.test.js && git -C WehdatHub-Server commit -m "feat: expose solo onboarding progress in today API"`

---

### Task 4: Shared Package & Mobile API Client — Signup Endpoint & Copy (`WehdatHub-App`)

**Files:**
- Modify: `WehdatHub-App/packages/shared/src/api.ts` (and validation schemas)
- Modify: `WehdatHub-App/apps/mobile/src/i18n.ts`
- Test: `WehdatHub-App/packages/shared/src/__tests__/authSignup.test.ts`

**Interfaces:**
- Produces: `api.signupSolo({ name, phone, lang, channel })` returning `{ ok: boolean, channel: 'telegram' | 'whatsapp', verifyUrl: string, codeMinutes: number }` + bilingual strings in `i18n.ts` for Welcome, Telegram Value Card, WhatsApp Loss Warning, Starter Card, Trial Pill, and iOS Billing Note.

- [ ] **Step 1: Write the failing test**
  Test `signupSoloSchema` validation and `api.signupSolo` request shape in `packages/shared`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `cd WehdatHub-App && pnpm --filter @wehdathub/shared test`
  Expected: FAIL.

- [ ] **Step 3: Implement `signupSoloSchema`, `api.signupSolo`, and bilingual `i18n.ts` keys**

- [ ] **Step 4: Run test to verify it passes**
  Run: `cd WehdatHub-App && pnpm --filter @wehdathub/shared test`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git -C WehdatHub-App add packages/shared apps/mobile/src/i18n.ts && git -C WehdatHub-App commit -m "feat: add solo signup API client and onboarding copy"`

---

### Task 5: Mobile App — Welcome & Self-Serve Solo Signup Flow (`LoginScreen.tsx`) (`WehdatHub-App`)

**Files:**
- Modify: `WehdatHub-App/apps/mobile/src/screens/LoginScreen.tsx`
- Test: `WehdatHub-App/apps/mobile/__tests__/LoginScreen.test.tsx`

**Interfaces:**
- Consumes: `api.signupSolo`, `api.verifyCode`, `Linking.openURL`
- Behavior:
  - Initial screen offers **"Start Free Trial"** and **"Sign In"**.
  - Signup step collects `name` + `phone`, displays the 3-bullet Telegram value card, and offers **"Continue with Telegram (Recommended)"** + **"Verify via WhatsApp instead"**.
  - Tapping WhatsApp shows a confirmation dialog listing what is lost without Telegram (voice-note unit entry, chat search, bot notifications) before opening the pre-filled `wa.me` link.
  - After opening Telegram/WhatsApp, transitions to the 6-digit `code` verification step for that phone number.

- [ ] **Step 1: Write the failing test**
  Test rendering "Start Free Trial", submitting `name` + `phone` for Telegram, and verifying the WhatsApp loss-warning modal appears before `Linking.openURL`.

- [ ] **Step 2: Run test to verify it fails**
  Run: `cd WehdatHub-App/apps/mobile && pnpm exec jest __tests__/LoginScreen.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Implement the dual Sign-In / Start Free Trial flow in `LoginScreen.tsx`**

- [ ] **Step 4: Run test to verify it passes**
  Run: `cd WehdatHub-App/apps/mobile && pnpm exec jest __tests__/LoginScreen.test.tsx`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git -C WehdatHub-App add apps/mobile/src/screens/LoginScreen.tsx apps/mobile/__tests__/LoginScreen.test.tsx && git -C WehdatHub-App commit -m "feat: add self-serve solo trial signup to LoginScreen"`

---

### Task 6: Mobile App — Home Starter Card, Calm Trial Pill & First-Unit Momentum (`WehdatHub-App`)

**Files:**
- Create: `WehdatHub-App/apps/mobile/src/components/StarterCard.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/components/SearchHome.tsx`
- Modify: `WehdatHub-App/apps/mobile/src/screens/AddUnitScreen.tsx`
- Test: `WehdatHub-App/apps/mobile/__tests__/StarterCard.test.tsx`

**Interfaces:**
- `StarterCard({ onboarding, telegramUrl, onAddUnit, onShareSample, onDismiss })`
- `SearchHome`: renders a subtle `Trial · Xd` pill (navigates to `Usage` screen on tap) and `StarterCard` until all 3 steps are done or dismissed (persisted locally via `AsyncStorage` / MMKV).
- `AddUnitScreen`: highlights "Paste a WhatsApp message or describe the unit" at the top, and on first unit save prompts to preview/share the Client Link.

- [ ] **Step 1: Write the failing test**
  Test `StarterCard` renders 3 steps, marks Telegram checked when `telegramConnected === true`, shows connect CTA when `false`, and hides when dismissed.

- [ ] **Step 2: Run test to verify it fails**
  Run: `cd WehdatHub-App/apps/mobile && pnpm exec jest __tests__/StarterCard.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Implement `StarterCard.tsx`, wire into `SearchHome.tsx`, and add first-unit nudge in `AddUnitScreen.tsx`**

- [ ] **Step 4: Run test to verify it passes**
  Run: `cd WehdatHub-App/apps/mobile && pnpm exec jest __tests__/StarterCard.test.tsx`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git -C WehdatHub-App add apps/mobile/src/components/StarterCard.tsx apps/mobile/src/components/SearchHome.tsx apps/mobile/src/screens/AddUnitScreen.tsx apps/mobile/__tests__/StarterCard.test.tsx && git -C WehdatHub-App commit -m "feat: add Home StarterCard, calm trial pill, and first-unit nudge"`

---

### Task 7: Mobile App — Trial & Bundles Overview + iOS Compliance Guard (`MoreScreens.tsx`) (`WehdatHub-App`)

**Files:**
- Modify: `WehdatHub-App/apps/mobile/src/screens/MoreScreens.tsx` (`UsageScreen`)
- Test: `WehdatHub-App/apps/mobile/__tests__/UsageScreenIos.test.tsx`

**Interfaces:**
- `UsageScreen`:
  - Shows "What's in your trial" (live Unit & AI credit progress bars + post-trial behavior), "What upgrading unlocks" (Solo vs Team), and "Available AI Bundles".
  - When `Platform.OS === 'ios'`, hides `pay-to-card` and `paymentChoices` buttons and displays a neutral note: *"Subscriptions and bundles are managed on your web account."*

- [ ] **Step 1: Write the failing test**
  Mock `Platform.OS = 'ios'` and assert `pay-to-card` and payment request buttons are NOT rendered while trial usage, plan comparison, and the neutral web note ARE rendered. Mock `Platform.OS = 'android'` and assert payment choices ARE rendered.

- [ ] **Step 2: Run test to verify it fails**
  Run: `cd WehdatHub-App/apps/mobile && pnpm exec jest __tests__/UsageScreenIos.test.tsx`
  Expected: FAIL.

- [ ] **Step 3: Update `UsageScreen` in `MoreScreens.tsx` with trial/upgrade/bundle cards and `Platform.OS === 'ios'` guard**

- [ ] **Step 4: Run test to verify it passes**
  Run: `cd WehdatHub-App/apps/mobile && pnpm exec jest __tests__/UsageScreenIos.test.tsx`
  Expected: PASS.

- [ ] **Step 5: Commit**
  `git -C WehdatHub-App add apps/mobile/src/screens/MoreScreens.tsx apps/mobile/__tests__/UsageScreenIos.test.tsx && git -C WehdatHub-App commit -m "feat: enhance Trial & Bundles view with iOS compliance guard"`

---

### Final Verification (Both Repos)
- Server: `cd WehdatHub-Server && npm run test:fast`
- App: `cd WehdatHub-App && pnpm typecheck && pnpm lint && pnpm test`
