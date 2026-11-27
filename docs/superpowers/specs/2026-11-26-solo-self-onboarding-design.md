# Solo Broker Self-Onboarding Design

**Date:** 2026-11-26
**Target User:** Solo real-estate brokers downloading the mobile app on their own (no sales team involved).

---

## 1. Goals
- Let any solo broker sign up and start a 14-day free trial directly inside the mobile app in under 2 minutes.
- Make **Telegram** the clear default by showing the concrete value of the Telegram bot before verification.
- Prevent drop-off for brokers who don't have Telegram by offering a **user-initiated WhatsApp fallback** (broker sends the first message so the reply code is free), while clearly stating what features they miss without Telegram.
- Guide new brokers to their first win inside the app within 5 minutes.

## 2. Non-Goals
- Multi-seat agency setup or team-rule configuration during initial signup (kept out of the solo flow; can be upgraded later).
- Paid SMS OTP (avoided to keep verification free).
- Manual sales approval or gated trial signups.

---

## 3. User Flow

### Step 1: Welcome & Choice (Mobile App)
- Replace the single "Sign In" dead end with two clear actions:
  - **"Start Free Trial"** (primary)
  - **"I Already Have an Account — Sign In"** (secondary)

### Step 2: Quick Signup Form
- **Name** + **Egyptian Mobile Number** (no agency name required—auto-created as a personal solo workspace).
- A short value card right on the screen explaining **why Telegram is recommended**:
  - Add units by voice note in seconds.
  - Search your inventory in chat.
  - Generate & forward client brochures and links from Telegram.
- **Primary Button:** **"Continue with Telegram (Recommended)"**
- **Secondary Link:** **"Don't have Telegram? Verify via WhatsApp instead"**

### Step 3A: Telegram Verification (Primary Path)
- Opens the Telegram bot with a one-time link.
- Broker taps **Start** and shares their phone number in one tap.
- Bot confirms their 14-day solo trial, sends their 6-digit login code (or deep-links back), and shows a quick welcome tip in Telegram.

### Step 3B: WhatsApp Fallback (Anti-Dropoff Path)
- Before opening WhatsApp, a short confirmation prompt warns them what they lose without Telegram:
  - *"You can still use the full mobile app, but without Telegram you'll miss voice-note unit entry, instant chat search, and bot notifications."*
- Broker taps **"Open WhatsApp & Send"** — opens a pre-filled message to the WhatsApp number.
- Because the broker messages first, the reply with the 6-digit login code is free (within the 24-hour customer service window) and proves number ownership.

### Step 4: First 5 Minutes Inside the App (Home Starter Card)
- No forced multi-slide onboarding carousel. Instead, show a **dismissible 3-step Starter Card** at the top of the Home screen:
  1. **Add or import your first unit:**
     - Opens Add Unit with **"Paste a WhatsApp message or describe the unit"** highlighted at the top (so fields auto-fill in seconds), **"Fill details manually"** below it, and an optional **"Load a sample unit"** to test immediately.
     - Checks off automatically on save and immediately nudges Step 2 (*"Unit saved! Preview & share its Client Link"*).
  2. **Share a client link** (preview & share their first unit or a sample unit so they feel the buyer experience immediately).
  3. **Try / Connect Telegram** (already checked off with a voice-note tip if signed up via Telegram; 1-tap connect button if signed up via WhatsApp).
- Card disappears automatically once all 3 steps are done or when dismissed.

### Step 5: Trial, Credits & Upgrade Visibility (Without Cluttering the App)
- **Never plaster banners on every screen.** Keep the workspace clean:
  - **Calm status pill** on Home (e.g., `Trial · 14d left`) — subtle, tappable, zero noise.
  - **Smart nudges only when relevant:** Show a friendly banner only when **≤ 3 days remain** on the trial, or when **Units / AI Credits hit 80% or 100%**.
- **Full "Trial & Plans" view** (opened by tapping the pill, a nudge, or **Settings → Plan & Billing**):
  - **What your trial includes:** Live progress bars for Units and AI Credits, plus what happens when the trial ends (data stays safe; adding/editing pauses until upgraded).
  - **What upgrading unlocks:** Side-by-side Solo vs. Team/Agency benefits.
  - **Available AI Bundles:** Clear top-up packs for extra voice/brochure credits.
- **Platform-safe checkout:**
  - **Android & Web:** In-app upgrade & bundle purchase with local payment methods.
  - **iOS:** Same full informational breakdown (usage, limits, plans, bundles), with no buy buttons or external checkout links—just a plain note: *"Subscriptions and bundles are managed on your web account."*

---

## 4. Key Trade-Offs & Decisions
- **Trial always open:** Self-serve trial signup must stay open by default so solo brokers never hit a "signups closed" wall.
- **WhatsApp kept secondary:** Offering WhatsApp only as a secondary link with a clear "what you miss" note protects Telegram adoption while eliminating hard drop-offs.
- **Calm visibility over constant upsells:** Keeping trial/credit status as a subtle pill until near limits preserves trust and keeps the app focused on closing deals.
- **iOS compliance first:** Read-only plan view on iOS avoids App Store rejection and Apple's 15–30% fee while keeping Android & Web frictionless.
