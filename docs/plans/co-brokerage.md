# Co-brokerage network: assessment and decision

Status: **pilot only, build postponed** (decided 2026-11-19). Nothing is built. Legal points below are unverified and need a lawyer.

## Idea

A private network where independent brokers and agencies collaborate on opportunities. WehdatHub connects the two sides; the brokers negotiate and close the deal themselves.

- **Inventory exchange:** a broker shares a unit (chosen fields only), other brokers find it, send a collaboration request, the owner accepts or declines, and contact details are revealed only after acceptance.
- **Requirements exchange:** a broker shares an anonymised buyer requirement (area, budget band, bedrooms, type, payment plan); WehdatHub matches it against shared inventory and alerts brokers.
- Guardrails: private by default, opt-in per unit, buyer identity hidden, acceptance before disclosure, audit record of who shared, accepted and when, expiry with periodic availability confirmation, sold or archived units leave the network, rate limits, reporting and blocking.
- WehdatHub never collects, holds or splits commission. (The CRM already records an outside broker's share of a deal in `services/deals.js`; that is the agency's own bookkeeping and the Terms should say so.)

## Verdict

Run a pilot only, and do it by hand before building anything. The ideas are sound, but the product is early (Founding Partner cap of 20, 14-day pilots, trial plan), the full build is large, and the real risk is the cold start, not the code.

Changes to the original proposal:

1. Do not price it as "Network Pro at 199 EGP". 199 EGP is already the whole Solo plan (`domain/plans.js:14`).
2. Show no photos before a request is accepted.
3. Coarsen the location before sharing (area level, no exact address, no lat/lng).
4. State the commission rule precisely (see above).
5. Treat the legal premises as unverified.

## Value and timing

- Brokers get more stock and more buyers. WehdatHub gets lock-in: a network cannot be copied by exporting to Excel.
- Assumption to test: the network is useful when about 10 agencies in the same 2 to 3 areas share about 300 live units and about 50 live requirements, and at least 30% of requirements get a match within 48 hours.
- WhatsApp groups are free and instant. WehdatHub only wins on what a group cannot do: structured matching, no stale units (expiry, sold units drop out), contact shown only after acceptance, and a dated record of who introduced what.

## Reuse and new work

Reusable (as templates, not as-is):

- Request and approve flow: `unit_access_requests`, `services/unitPrivacy.js`, `services/accessQueue.js`. The table belongs to one agency, so it is a pattern only.
- Allow-list serializer: `domain/publicUnit.js`. Copy it into a new `domain/networkUnit.js`.
- Matching: `services/leadRequests.js`, `services/matchSweep.js`. The SQL is hard-scoped by `l.agency_id = $1` (`services/search.js:165,435`), so a network variant is needed.
- Place and project names: `services/globalProjects.js`, `lib/placeNames.js`.
- Anonymisation thresholds: `domain/analyticsPrivacy.js`.
- Logging: `audit_logs` (append-only, kept 12 months), `logOperation`.
- Also: `lib/rateLimit.js`, `lib/notifications.js` and `lib/notificationPolicy.js` (new kinds), `lib/planGuard.js`, and the per-agency switch pattern (`agencies.analytics_enabled`).

New: tables `network_shares` (listing_id, chosen fields, expires_at, confirmed_at), `network_requirements`, `network_matches` (separate from `lead_matches`, whose agency_id and listing foreign key assume one agency), `collaboration_requests`, `network_blocks`, `network_reports`; web, API and mobile routes; a reverse-matching job.

## Security and tenant isolation (biggest risk)

- RLS gives no protection here: every table has RLS with no policies and the app connects as the table owner (`db/migrations/010_lock_public_api.sql`). Isolation lives only in code (about 527 `agency_id = $` clauses plus `lib/visibility.js`, which handles `is_private` and compound approval but never checks the agency).
- Rule: never loosen an existing query. Build one separate read path that touches only `network_shares` joined to listings through the network serializer. Add a guard test (like `tests/visibility-guard.test.js`) that fails if any network read selects `l.*` or `details`.
- Secrets sit inside `listings.details` (owner_name, owner_phone, commission, co_broker, notes, unit_no, address; see `services/unitPrivacy.js:14`) plus exact lat/lng. Any `SELECT *` leaks them.
- Photos are permanent public URLs, cached as immutable (`lib/supabase.js:58,80`), and cannot be revoked. Project and logo paths start with the agency id; unit photo paths probably do too, which would reveal the "anonymous" agency. Before acceptance show no photos, or re-encoded thumbnails under random names.
- Threats to design for: fake accounts harvesting inventory (verify brokers, cap results, pilot or paid agencies only), scraping (rate limits per broker and agency), client-stealing after contact reveal, re-identifying an anonymised requirement (use budget bands from `docs/analytics-plan.md` and area level only).
- Keep the "view another agency" read-only mode (`lib/viewGuard.js`) separate from the network.

## Privacy

- Recorded, dated consent of the unit owner before a unit is shared.
- Buyer consent even for an anonymised requirement, since it may still be personal data.
- Whether WehdatHub is controller or processor for network data is a lawyer question.
- Expired or deleted shares are removed and drop out of matches; keep only the audit row with hashed identifiers. Link into the erasure path in `services/privacy.js`.

## Legal (unverified, needs a lawyer)

Only news sources were found, not official text: Ministerial Decision 578/2025 under Law 120/1982 (amended by Law 21/2022), a GOEIC broker registry, a July 2026 compliance deadline, broker types and tiers. The "2025 Executive Regulations" text was not found. Law 151/2020 (data protection) exists; how far it applies is unverified.

Questions for the lawyer:

1. Does the platform need a GOEIC registration?
2. Must network members be registered, and should WehdatHub check their registry number?
3. Does matching or introducing count as brokerage or intermediation?
4. Who is liable for a wrong or stale listing?
5. How do we stay out of co-brokerage disputes, and is the audit log usable as evidence?
6. Which Terms clauses are needed: no commission role, no guarantee, anti-circumvention, takedown?
7. What consent wording is needed for owners and buyers?
8. Are WhatsApp exports of shared data acceptable?

Do not launch the built network before these are answered.

## Performance and cost (free tier)

Negligible at pilot size. Watch the pool max of 10, the 10-second statement timeout (`config.js`) and the Render cold start (`lib/keepAwake.js`). Add a partial index on `network_shares` (area, type, deal type, price) where active and not expired. Match only units that changed. Send network alerts by Telegram, push or in-app digest, not WhatsApp (capped and paid).

## Trust and abuse

Owner approves each agency by hand (registry number, a call). Shares expire after 14 days unless reconfirmed with one tap; sold or archived units leave automatically. Track per agency the share of requests answered, time to answer and reports received. Block, report, three strikes. Pilot with 10 to 15 agencies (Founding Partners first) in 2 to 3 overlapping areas with a weekly call.

## Money (assumptions)

199 EGP only works as an add-on for Solo users. Better: free during the pilot, then 300 to 500 EGP/month as an add-on, or included in Office and Agency plans. Gate share caps, alerts and analytics; never gate seeing contact details. Postpone featured listings: they bias matching, create a conflict of interest and hurt trust.

## Smallest first test (about 1 week, no build)

1. The owner runs a curated WhatsApp or Telegram group of about 10 agencies.
2. Brokers post existing share links (`web/routes/publicUnit.js`, which already hides owner, commission and notes) and banded requirements through a Google Form.
3. The owner matches by hand and logs requests, acceptances and deals in a sheet.
4. Tell participants: a client who fills the interest form on a shared page becomes a lead of the agency that shared the link.

## Go or stop after 8 weeks

- Go if at least 60% of pilot agencies share 10 or more units each, at least 30% of requirements are matched within 48 hours, at least 50% of requests are answered within 24 hours, at least 3 deals are closed and attributed, and there are no leak incidents.
- Stop if requests mostly go unanswered or brokers keep using WhatsApp anyway.

## Build plan if "go" (behind `agencies.network_enabled`, owner switch, off by default)

| Step | Size | Content |
|---|---|---|
| 0 | none | The manual pilot above |
| 1 | M | Migration for `network_shares`, `collaboration_requests`, blocks and reports; `services/network.js`; `domain/networkUnit.js`; web and API routes; app screens; guard test |
| 2 | M | `network_requirements` and `network_matches`; network variant of `matchSweep`; banding |
| 3 | S | Plan gating in `lib/planGuard.js` and `domain/plans.js` |
| 4 | L | Wider network, verification flow, reputation |

## Do not

Relax `agency_id` filters or add a viewer bypass to `Vis`; show photos or exact location before acceptance; charge per reveal or hold commission in escrow; open sign-up to the network; launch the built network before the lawyer answers. Not verified: production agency count and live usage were not queried.

Sources (news, not official text): Property Finder blog (propertyfinder.eg/blog/?p=27106), Invest-Gate, Daily News Egypt (two articles), Zawya.
