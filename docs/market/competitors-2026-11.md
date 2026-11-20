# Competitor analysis, November 2026

Competitors: Whispyr AI (whispyrai.com), V Estate (vilartech.com), RabetCRM (rabetcrm.com). Their pages were read on 2026-11-20; everything about them is the vendor's own claim. Section 7 (website) is postponed and kept as the reference design.

## 1. Price comparison (EGP / month)
| | 5 users | 15 users | Trial |
|---|---|---|---|
| **WehdatHub** | Team **599** | Office **1,790** | 14 days, no card + Free (50 units) |
| Whispyr | Growth 400 (WhatsApp and AI are add-ons) · Intelligence 1,250 | 1,200 · ~3,525 | Free plan |
| V Estate | ~625 (7,500/yr); AI plans quoted by sales | quoted | Demo only |
| Rabet | Starter 2,499 | Business 6,666 | 15 days |

## 2. Competitors in one line each
- **Whispyr**: lead routing + cold-call pool + Meta/Property Finder intake. Inventory is a bare menu item, there's no map and no mobile app, and paid plans need a sales call.
- **V Estate**: CRM + branded website + branded app. No tier prices, no trial, undefined "V Points", no map.
- **Rabet**: generic multi-industry CRM. Portal feeds, developer installment reminders, OpenStreetMap map, 14 area SEO pages. **The "Madinaty search" is just generic unit fields.** There is no Madinaty data loaded, the Madinaty page is thin with Dubai screenshots, and the prices on the site contradict each other.

## 3. Our strong points (keep them off the website: show outcomes, not mechanics)
Inventory depth; voice/free-text add and search in Egyptian Arabic; automatic match alerts and price-drop alerts; client links with "opened" alerts; area tree + ~3,090 map pins; Excel import with preview/undo; native app + PWA + Telegram Mini App; data-protection law compliance; lowest price.

## 4. Gaps vs competitors, with status
| Gap | Status in code | Action |
|---|---|---|
| Meta lead ads | **Built.** Direct webhook `POST /webhook/leadgen` (`services/leadIntake.js`, migration 135, `docs/facebook-lead-ads.md`). The owner pastes a Page token per agency on `/app/owner`. | Fix the landing copy, which says "from a CSV file". Later: a self-serve "Connect Facebook" button (Facebook Login for Business). That needs Meta App Review and Advanced access, so it's not in this plan. |
| Portal leads (Dubizzle, Nawy, Property Finder, Bayut) arrive as WhatsApp messages to the owner | Paste→enquiry works **only in Telegram** (`routes/dispatch.js:194` → `services/portalEnquiries.js` capture → `services/portalPicker.js`). Web only **lists and assigns** them (`web/routes/portalEnquiries.js`). The app has none. | **Section 6** |
| Madinaty/Rehab phase search | Madinaty and Rehab are compounds in `map_places` (`data/map-seed/master.json:111`, `:642`), which have no children. | **Section 5** |
| Public agency showroom | `docs/plans/agency-page.md`, ~60% built | later |
| Developer installment reminders | payment plan already stored | later |
| Professional website | single page `web/routes/landing.js` | **Section 7** |

---

## 5. Madinaty and Rehab phases as sub-areas (chips)
**Approach: reuse the `areas` tree. No new location model.** The tree already supports area → sub-zone with chips, search and map (`areas`, depth trigger at `SCHEMA_REFERENCE.sql:114-140`). The unit box already shows a place chip for "compound, sub-zone or area" (`web/views/unitForm.js:62`, `services/placeSuggest.js:52 placeChip`).

1. **Seed** `data/areas/compound-phases.json`, in the same format as `data/areas/areas.json` (en, ar, aliases, lat, lng, children):
   - **Madinaty / مدينتي** → B1 … B15 (aliases "b6", "بي 6", "المرحلة السادسة"), plus villa zones and named districts (Privado, Celia, Craft Zone, The Spine, Golf Heights …).
   - **El Rehab / الرحاب** → Rehab 1, Rehab 2 and phases 1 … 10 (aliases "مرحلة 7", "الرحاب 2").
   - **The owner reviews the phase list before the migration.** There is no official dataset, so the list comes from the owner's market knowledge.
2. **Migration** `136_compound_phases.sql`, following the pattern of migrations 111/115 (back up `areas`, idempotent insert by `name_key`). It inserts the Madinaty and Rehab areas with their children, then sets `map_places.area_id` for the Madinaty and El Rehab compounds to those areas. Choosing the compound then offers its phases.
3. **Unit box**: when the place is the Madinaty/Rehab compound (or its area), show the phase chips. On save, `listings.subzone_id` is the phase. Check web (`web/views/unitForm.js`, `domain/unitBox.js`) and app parity (`docs/app-parity.json`).
4. **Parser and search**: make sure place resolution (`services/compoundResolve.js`, `services/placeLookup.js`, `domain/places.js`) maps "مدينتي B6", "b6 madinaty" and "الرحاب مرحلة 7" to the sub-zone. A search on "Madinaty" includes all its phases, and a search on "B6" narrows to that phase. Excel import: the phase text resolves through the same lookup (`domain/sheetImport.js`).
5. **Map**: phase centroids come from the seed lat/lng, so units without a pin land on their phase.
6. **Backfill (optional)**: a one-off script that matches the text of existing Madinaty/Rehab units (`compound` and notes) to a phase. Dry-run first, owner approves.

## 6. Portal-enquiry capture on web and app (the "better way")
Today the owner copies the portal's WhatsApp message and pastes it into Telegram. Plan:
- **App: share straight from WhatsApp.** The app already has a share extension. When the shared text parses as a portal enquiry (`domain/portalEnquiry.js` `parse`), open a "Portal enquiry" screen. It is prefilled with portal, name, link and listing no.; the manager types the phone, picks the broker, and saves. One share, one tap, no copy-paste. Manager or owner role only, like Telegram.
- **Web: a paste box** at the top of the `/app/leads?tab=portal` panel, using the same parse → capture → assign form (reuse `web/routes/portalEnquiries.js` assign form).
- **API**: `POST /api/portal-enquiries/read` (parse only, nothing saved) and `POST /api/portal-enquiries` (capture + optional assign). They wrap `services/portalEnquiries.js` capture/assign, with the same rate limit pattern as `/leads/extract` (`api/leads.js:98`).
- Also route `/leads/extract`: if the text is a portal enquiry, return `{portal: true, …}` so the app's generic "paste a lead" flow switches to the portal screen.
- Later (free tier OK): a per-agency inbound email address for portals that send email, using Cloudflare Email Routing → webhook. Needs owner setup, so it's not in this plan.

## 7. Website restructure (outcomes only, animated, no names)
Keep server-rendered `web/routes/landing.js`. Add a small deferred script for animations only, keeping `scripts:false` for the app bundle.

**Order:**
1. **Nav**: Product · Pricing · Areas · Guide · العربية/English · Sign in · **Start free**.
2. **Hero**: outcome H1 ("ولا وحدة ولا عميل يضيع منك تاني"), subhead about outcomes (find the right unit for a client in seconds, follow-ups never forgotten), primary "ابدأ ببلاش", secondary "كلّم المبيعات", 3 reassurance bullets. **Animated showcase**: the existing `landingShowcase` mock plays as a loop: a message line types in → the unit card assembles → the "3 matching buyers" alert slides in.
3. **Numbers strip**: real counts only (agencies, units) or pilot logos with permission. If there are none yet, skip it.
4. **Before / after**: "Excel and WhatsApp groups" vs "WehdatHub", 3 pairs (lost leads, forgotten follow-ups, outdated sheets).
5. **Outcome cards** (6): each is a result with an animated mini-mock. No explanation of how voice parsing, matching rules or the map work.
6. **"vs traditional CRM" table**: rows are built for Arabic brokers, inventory + clients together, works from the phone, setup in minutes, price. No competitor names.
7. **Pricing teaser** with a "Most popular" badge on Team. Move the credit table, bundles and payment notes to a new **`/pricing`** page.
8. **FAQ** (6–8 direct answers) + FAQPage JSON-LD.
9. **Closing CTA band** + footer (guide, privacy, terms, refund, contact, social).

**Copy fixes**: drop "WhatsApp" as a channel (STEPS line 36 says "Telegram, WhatsApp or Excel"), drop "Facebook leads from a CSV file", and change the page title from "Units and clients on Telegram" to "WehdatHub | برنامج إدارة الوحدات والعملاء للبروكرز في مصر".

**Animations**: CSS + IntersectionObserver reveal (fade-up, 40–60 ms stagger), number count-up, showcase loop, card hover lift, gradient accent on the hero, smooth anchor scroll. Transform and opacity only, no layout shift. Full `prefers-reduced-motion` fallback. No libraries. Use the `frontend-design` and `design-principles` skills for the visual pass and existing brand tokens (`domain/brand.js`).

**Area pages** `/crm/<slug>` (e.g. `/crm/madinaty`) are built from `areas` + `map_places`: compound and phase lists, local FAQ, CTA at top and bottom, sibling links. They never show agency units or counts. Add `sitemap.xml`, canonical and hreflang tags.

