# Market analytics: plan, privacy and finance (DRAFT, needs review)

Status: DRAFT written without a lawyer or accountant. Section 4 (legal checklist) and section 5 (finance) are for the owner and counsel to review before any agency is charged or any report is promised. The Terms and Privacy clauses added on 19 November 2026 (`web/routes/legal.js`, Terms 11 and Privacy 12) are drafts of the same kind.

## 1. What is collected, and why now

History cannot be rebuilt later: searches are deleted after 90 days, a unit's old price is overwritten, and a sold unit loses its "days on the market" unless the moment is written down. So the app now records aggregates every night, and shows them to the owner. Agencies see them only when the owner switches the feature on for them (a future paid extra).

| Table | Grain | Holds | Never holds |
| :--- | :--- | :--- | :--- |
| `analytics_search_daily` | day, area, property type, sale/rent, bedroom band (0-4, 5+), budget band | `searches`, `zero_result` counts | query text, broker, agency, result ids |
| `listing_prices` (existing) | one row per price change of a unit | price, source, time, agency, unit | (internal history; only feeds aggregates) |
| `listing_status_events` | one row per status change of a unit | from, to, price at that moment, time, `approx` flag | (internal history; only feeds aggregates) |
| `analytics_market_daily` | day, area, type, sale/rent, bedroom band | active, new and removed units, price per m² (p25/p50/p75), median price, sold count, median days to close, asking-vs-closed %, `agencies_n`, `rows_n` | agency ids, unit codes, addresses, owners, photos, notes |
| `analytics_funnel_monthly` | month, agency (its own row) and a market row | leads, contacted, viewings, deals, lost, median first response, counts by source and by lost-reason bucket, rates | names, phones, notes, free-text reasons (they are bucketed) |
| `analytics_meta` | key | last-run summary, "counted through" marker | - |

Bands are fixed EGP ranges (sale: <1M, 1-2M, 2-3M, 3-5M, 5-8M, 8-15M, 15M+; rent per month: <10k, 10-20k, 20-40k, 40-80k, 80k+), not quantiles of the data. Sources are mapped to the fixed source list or "Other"; lost reasons are mapped to the fixed categories (price, location, bought elsewhere, financing, not serious, no answer, other); the typed text is discarded. Only resale units that are not private are used; prices in a currency other than EGP are ignored.

Limits worth knowing: `asking_vs_closed_pct` uses the price at the moment the unit was marked sold against the deal price recorded in the CRM, so it exists only where a deal was linked to the unit. `median_days_to_close` uses exact status events only (the backfilled `approx` events are ignored). Supply is a snapshot taken at about 02:00 Cairo for the day just ended. Search area comes from the area the search resolved to (`area_scope`); a search with no known area counts under "no area".

## 2. Privacy rules (enforced in code at write time)

* Thresholds in `domain/analyticsPrivacy.js`: a market cell needs at least 5 different agencies and 10 rows (`MIN_AGENCIES`, `MIN_ROWS`); percentiles need 10 priced units from 5 agencies; days-to-close and asking gap need 5 closed units; the market funnel row needs 5 agencies with at least 3 leads each that month. Demand cells under 10 searches are shown as "Not enough data" (they are stored; they carry no identity).
* A cell below the thresholds is not written. Its units still count in a wider cell that passes (place plus bedrooms, then place, then the parent place, then the whole market), so there is no "detail with small numbers".
* `assertClean()` throws if a row, CSV or report holds a forbidden field name (phone, name, notes, unit code, raw text, query text, broker id, owner, address, photos, email) or a phone-like value; it runs before every write and every read of the reports. Tests scan fixtures with names and phones through all tables, CSVs and pages.
* Day, month and band granularity only; no addresses; no unit codes.
* Access: all analytics tables have row-level security on and no policy, so the Supabase Data API reaches nothing; only the server (table owner) reads them, and only through `services/analytics.js`, which re-checks the role and the agency switch on every call. The agency path takes the agency id from the signed-in person and has no way to ask for another agency. The owner path is limited to `OWNER_BROKER_IDS`.
* Known limit: with thresholds of 5 agencies and 10 rows, someone who holds both a cell and its parent could subtract to estimate a small remainder. The numbers are medians and counts of at least 5 agencies, so the risk is low, but counsel may want a higher k or rounding of counts before the reports are sold.

## 3. Retention and erasure

* Aggregates are kept indefinitely. They hold no row-level data and, except an agency's own funnel row, no agency identity.
* `analytics_funnel_monthly` rows with an `agency_id` are deleted with the agency (`ON DELETE CASCADE`). `listing_status_events` rows are deleted with the agency (cascade); `listing_prices` already cascades.
* Market cells and search counts carry no agency id, so agency erasure needs nothing more. A lead erased for a client's request (`services/privacy.js`) leaves only counts behind, which are not personal data.
* Raw rows keep their existing retention: `search_log` 90 days (now counted first), CRM leads 18 months.

## 4. Data-protection checklist for counsel (Egypt Law 151 of 2020)

1. Lawful basis for creating anonymised statistics from the service's operational data: legitimate purpose of improving the service, or consent through the Terms. Confirm which one to rely on, and whether anonymisation itself is a processing step that needs a basis.
2. Is the output really anonymous? Confirm the thresholds (5 agencies, 10 rows), whether to round counts, and that "agency's own funnel next to the market median" cannot single out a competitor.
3. Controller and processor roles: the Privacy Policy says agencies are controllers of their client data and Wehdat Hub is a processor. Using that data for statistics may make Wehdat Hub a controller for that step. Decide and word the Terms accordingly (Terms 11 and Privacy 12 are drafts).
4. Notice: Terms and Privacy pages now mention aggregated statistics and the minimum group size; confirm wording, the Arabic text, and whether existing agencies must be notified or must re-accept the Terms.
5. Opt-out: there is none for agencies' contribution to the aggregates today. Decide whether one is needed (the switch only controls whether an agency can read reports).
6. Search text: the search count never stores the text, only the filters the search used. Confirm that the fixed bands are acceptable.
7. Access control and logs: owner-only reads, the per-agency switch is logged (`owner_analytics`), CSV export is owner-only. Confirm retention of those logs.
8. Cross-border: aggregates stay in the same Supabase project as the rest of the data (Europe). Confirm nothing changes.
9. Selling reports: if reports become a paid product, confirm invoicing, VAT and whether a data-licence clause is needed in the agency contract.
10. Contact for questions: `wehdat.hub@gmail.com` (named in the clauses).

## 5. Finance note (estimates; assumptions stated)

### 5.1 Storage and compute

No market data was invented; the figures below are formulas with stated assumptions. Replace the assumptions with real counts after a month of running (the last-run counts are on the owner's tab: `analytics_meta` key `last_run`, `tables`).

Assumptions: about 200 bytes per aggregate row including its index (a 17-column numeric row is roughly 120 bytes plus an index entry); Supabase Free gives 500 MB of database; the app already uses part of it.

* `analytics_search_daily`: at most one row per distinct combination per day. Worst case is bounded by the searches per day. At 1,000 searches a day with typically 200 distinct combinations: about 200 rows a day, 73,000 a year, about 15 MB a year.
* `analytics_market_daily`: rows per day = passing cells. Upper bound per area that passes: types (up to 8 used) times sale/rent times (1 + bedroom bands 6) = 112, but with 5 agencies and 10 units required, in practice far fewer pass. Example: 40 passing areas with about 6 passing cells each = 240 rows a day, 88,000 a year, about 18 MB a year. Early on (a handful of agencies) almost nothing passes and the table stays tiny.
* `analytics_funnel_monthly`: agencies times 2 recomputed months, one row per agency per month plus one market row. 100 agencies: 1,200 rows a year, negligible.
* `listing_prices` and `listing_status_events`: one row per price or status change. At 50,000 units with each changing about twice a year: 200,000 rows a year, about 30 to 40 MB a year. This is the largest line and the reason the history is recorded by trigger now.

If total growth approaches the free limit, the lever is compaction: keep `analytics_market_daily` daily for 90 days and weekly after (a later migration), or move to a paid database tier. No compaction is built.

Compute: the nightly job reads units once (limit 150,000 rows) and leads of two months, aggregates in memory (a few seconds), and writes at most a few thousand rows in batches of 200. It has a 60-second budget. Search counting reads one week of `search_log` per transaction. No analytics query runs per page view except small indexed reads of the aggregate tables by the owner or by an enabled agency. No new paid service.

### 5.2 Suggested pricing frame (ASSUMPTION for the owner to decide)

Not market data and not a recommendation from research: a starting point for discussion. Existing plans (`domain/plans.js`): Solo 199, Team 599, Office 1,790, Agency 2,990 EGP per month.

* Option A, included in the top plan: switch it on for Agency plan customers at no extra charge, as a reason to upgrade from Office (1,790 to 2,990 EGP a month).
* Option B, monthly add-on: 300 to 500 EGP per agency per month for any plan, shown as "Market analytics", switch on after the payment is confirmed. At 100 agencies and 20 percent take-up this would be about 6,000 to 10,000 EGP a month; the cost to serve is close to zero, so almost all of it is margin.
* Option C, free for founding partners (`founding_partner`) for the first year, paid afterwards.

The control is the per-agency switch (`agencies.analytics_enabled`): turning it on or off needs no deploy and is logged. Billing for the add-on is not built; today the owner records the payment by hand and flips the switch. Check VAT treatment and invoicing with an accountant.
