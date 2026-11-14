// tests/harness/clean-env.js — Runs before every test file (jest setupFiles): removes the machine's own settings for outside
// services, so the suite gives the same result on a laptop with a .env or exported keys as on CI with none. Tests that need a
// setting set it themselves.
"use strict";

const OUTSIDE = /^(SUPABASE_|GEMINI_|GOOGLE_MAPS_|DATABASE_URL$|PG(HOST|USER|PASSWORD|DATABASE|PORT)$|TELEGRAM_|WHATSAPP_|RENDER_|ALERT_|FIREBASE_|WEB_PUSH_|OWNER_BROKER_IDS$|ADMIN_|SEARCH_|STORAGE_|PUBLIC_BASE_URL$|SESSION_SECRET$|R2_|CLOUDFLARE_|MAKE_)/;
for (const k of Object.keys(process.env)) if (OUTSIDE.test(k)) delete process.env[k];
