# Agency page (white-label portal): assessment and decision

Status: **postponed** (decided 2026-11-19). Nothing is built. This file keeps the conclusion so the work can restart without repeating the assessment.

On screen and in code the feature is called **"Agency page"** (`صفحة الشركة`). The word "portal" is already used for Bayut/Dubizzle/Nawy enquiries (`services/portalEnquiries.js`).

## Idea

Each agency gets a public, client-facing page that lists only its own units, to share with clients: `https://<site>/<agency-slug>` for the catalogue and `https://<site>/<agency-slug>/<unit-code>` for a unit. The site is the Render address now and the permanent domain later; a custom domain per agency comes last. Agencies pay extra (setup fee, monthly branding fee, custom domain).

## Verdict

Doable. About 60% already exists:

- `web/routes/publicUnit.js` serves `/<slug>/<unit-code>?s=<token>` and `/<slug>/compare/<token>`.
- `domain/publicUnit.js` is a whitelist serializer (only approved fields are shown).
- The pages already have noindex, `no-store`, rate limits, link previews, AR/EN, payment plans, a schedule PDF and an interest form that calls `Leads.captureLead`.
- `agencies.slug` is unique and checked against reserved words (`domain/slug.js`, migration 005).

Missing: a token-free catalogue and unit page that works only when the agency switches it on and ticks each unit.

## Value

- Agencies: one branded link for WhatsApp, bios and ads; enquiries land in their CRM.
- WehdatHub: add-on revenue, lock-in once the link is printed, a "Powered by WehdatHub" footer on lower tiers.
- Every enquiry is attributed to its source.

## URL and routing

- Add `GET /:slug` (catalogue) and token-less `GET /:slug/:code`. With `?s=` present, keep today's share-link flow (the lead goes to the broker who shared it).
- Look slugs up in lower case and 301 to the canonical form (`/NCH/...` to `/nch/...`); `SLUG_RE` rejects capitals today.
- Add to `RESERVED_SLUGS`: `go`, `telegram` (`server.js`), `try` (`landing.js`), `compare`, `v`, `en`, `ar`, `sitemap`.
- Keep old slugs in `agency_slug_history` and 301 to the new one. There is no screen to change a slug today.
- Custom domain later: look up the `Host` header in `agency_domains`, add the domain on Render (TLS is automatic; Cloudflare record must be DNS-only). `sameOrigin()` in `web/security.js` must then also accept each verified domain, or the enquiry form is refused.

## Data model (one migration)

- `agencies.portal jsonb`: enabled, tagline_ar/en, about, whatsapp, show_broker, theme, sections, powered_by. Reuse the existing colour columns (`brand_color`, `accent_color`, `primary_color`, `secondary_color`).
- `listings.portal_visible boolean DEFAULT false`.
- New tables: `agency_slug_history`, `agency_domains` (domain, verified_at, status).
- Index `(agency_id, portal_visible, status)`.

## Page content

First version: logo, name, tagline, filters (area, type, sale or rent, price band, bedrooms), unit cards with 360x270 thumbnails (`lib/images.js makeThumbBuffer`), the unit page (reuse `unitBody`), WhatsApp and call buttons, enquiry form, AR/EN, a "no longer available" state.

Later: About section, project and compound pages, featured units, map, broker cards, downloadable branded catalogue (reuse `lib/schedulePdf.js` and the flyer code).

## Customisation tiers

- T1: logo, two colours, tagline, contact details, WhatsApp number.
- T2: choose and order sections, cover image, featured units, hide the footer badge.
- T3: custom domain.
- Always fixed: layout grid, typography, the serializer, the legal notice, colour contrast (refuse colours that fail it). Never allow custom HTML, CSS or JS.

## Security and privacy

- A unit shows only when: `status='active'`, `deleted_at IS NULL`, `stale_hidden_at IS NULL`, `Vis.units()` passes, and the agency ticked it. Default off.
- Output only through `toPublicUnit`. Never show owner data, commission, owner phones, exact address, lat/lng, raw text or ids.
- Broker contact only if the agency ticks `show_broker`; otherwise the agency's own number.
- Rate limits: reuse `publicPageIp` (120/min) and add one per slug. Cap page size, no infinite scroll.
- Branding text stays escaped; colours must match `^#[0-9a-f]{6}$`; logos are re-encoded to PNG (`services/agencyLogo.js`), never raw SVG.
- Every query filters by `agency_id`.
- The owner approves an agency's name and slug before the page goes live (stops impersonating another brand) and has a kill switch.

## Search indexing (SEO)

Decision: keep **noindex** for now, build the SEO parts in from the start, and switch indexing on later per agency.

Why wait:

1. The address will change. Moving from `onrender.com` to the permanent domain needs 301s and still loses ranking for weeks.
2. A subdomain on a shared host ranks poorly.
3. Cold starts on Render free (30 to 60 seconds) hurt crawling.
4. Slugs can change, which leaves dead indexed URLs.
5. Short, similar unit pages rank badly and can lower the whole domain's quality.
6. Owners did not agree to their units being on the open web. Agencies must opt in, and pages must drop out of results when a unit is sold.

Build in from day one: an `indexable` flag per agency (default off), a per-agency `/sitemap.xml`, title and meta description per page, canonical links, schema.org real-estate markup, and `410 Gone` or `noindex` once a unit is sold or hidden.

Where SEO pays: area and compound pages and the agency's brand search, not single unit pages (Aqarmap and OLX dominate those). Option: allow indexing earlier for T3 agencies that bring their own permanent custom domain.

## Lead flow

Copy the pattern in `services/leadIntake.js`: the system acts as manager of the agency, `LeadRules.nextBroker` picks the broker, `captureLead` with `{ source: "Agency page", lawfulBasis: "consent", consentNote, notes: unit code + page }`, then `advanceRotation` and `notifyBroker`. Keep the honeypot field and rate limits from `publicUnit.js`.

## Cost, performance, scale

- Short cache: `Cache-Control: public, max-age=60` plus an ETag from the agency's last listing update. One indexed query per page.
- Thumbnails in lists, 1600px images only on the unit page. Photos come from Supabase public URLs with a 1-year immutable cache.
- Bandwidth is the binding limit: Supabase free egress is roughly 5 GB/month (unverified, confirm).
- Render free sleeps after 15 minutes idle. A client's first open can take 30 to 60 seconds, which is the strongest reason for a paid Render plan. `lib/keepAwake.js` covers working hours only. `render.yaml` says `plan: starter`; confirm which plan is live.
- Pages are stateless; next step is Cloudflare in front, caching public GETs only.

## Monetisation (assumptions, not market data)

Gate with an owner switch on the agency page in `web/routes/dashboard.js`, like `/owner/price-reading/:id` (stored on `agencies.price_reading`). During plan grace the pages stay up; in read-only or blocked they show "contact the agency" and no units (as `planGuard` treats old links).

Suggested prices, relative to Team 599 and Office 1,790 EGP/month:

- T1: 299 EGP/month, or included in Office and Agency plans.
- T2: 599 EGP/month.
- T3: 999 EGP/month plus 1,500 EGP setup; the agency buys its own domain.

Marginal cost is near zero on the free tier. The real cost is egress and support time (about 1 hour per T3 setup).

## Terms and legal (needs review by counsel)

The agency is responsible for accuracy, photo rights and its right to advertise each unit; no use of another brand's name or mark; WehdatHub may take down or suspend; WehdatHub is a host, not the broker; client data belongs to the agency as controller and WehdatHub is processor; consent text under the enquiry form; prices are indicative; custom domain and DNS rules; refund of setup fees; behaviour when the plan lapses.

## Build plan when resumed

- P1 (M): migration, `services/agencyPage.js`, `GET /:slug` and token-less `/:slug/:code` in `publicUnit.js`, enquiry route with round robin, reserved slugs, owner switch in `dashboard.js`, per-unit toggle in `unitForm.js`, tests modelled on `tests/web/public.test.js`.
- P2 (S): T1 branding form in settings, slug-change 301s.
- P3 (M): T2 sections, featured units, catalogue PDF.
- P4 (L): Host-header routing, domain verification, `sameOrigin` change, adding the domain through Render.
- App (S): "show on agency page" toggle and "share agency page" button in `UnitSections.tsx`.

Recommendation: build P1 and P2 behind the owner switch, pilot T1 with Office clients, and charge for custom domains only once a paid host and the permanent domain exist.

## Do not

Show all units by default; allow custom HTML or CSS; allow indexing on the onrender.com address; offer custom domains before the permanent domain and a paid host; promise uptime on the free tier; let agencies pick slugs without approval.
