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

### Step 4: First 5 Minutes Inside the App
- Instead of an empty screen, the new broker sees a dismissible **3-step Starter Checklist**:
  1. **Add or import your first unit** (paste a WhatsApp message, upload a photo/details, or try a sample).
  2. **Share a client link** (see what your buyer sees).
  3. **Connect / try the Telegram bot** (especially visible if they verified via WhatsApp, giving them a second chance to unlock Telegram features later).

---

## 4. Key Trade-Offs & Decisions
- **Trial always open:** Self-serve trial signup must stay open by default so solo brokers never hit a "signups closed" wall.
- **WhatsApp kept secondary:** Offering WhatsApp only as a secondary link with a clear "what you miss" note protects Telegram adoption while eliminating hard drop-offs.
- **Re-prompt inside the app:** Brokers who choose WhatsApp can still connect Telegram later from their starter checklist or settings.
