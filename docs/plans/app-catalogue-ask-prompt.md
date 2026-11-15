# Prompt for the WehdatHub-App chat: developer catalogue and Ask, matching the website

Paste this into a Claude Code chat opened in `D:\code\WehdatHub-App`. The server repo is at `D:\code\WehdatHub-Server`
(read-only for you; do not edit it). Everything below is **built and tested on the server** (website and API); build the app side against it.

First sync this folder with the repo's main branch. Leave uncommitted work alone: do not commit or discard it.

Read first: `docs/plans/unified-unit-box.md` (the box), `web/views/projectForm.js`, `web/views/catalogueList.js`,
`web/static/projectForm.js`, `web/static/catalogueSearch.js`, `domain/projectPaste.js`, `services/projectPaste.js`,
`services/projectRows.js`, `web/routes/catalogue.js`, `api/ask.js`, `api/more.js`, `API_CONTRACTS.json`.

## A. Catalogue

### A1. Catalogue list and search (replaces the old list)
- One search box with chips, the same suggestions as the unit box plus developers and projects.
  Website: `GET /app/catalogue/search-box?q=` → `{ items: [place…, { kind:"feature", key, label }…, { kind:"developer", id, label }…, { kind:"project", id, label }…] }`.
  App: use the same `GET /api/places/box?q=&scope=areas` for places and features (`scope=areas` is built on the API route too) and developers and projects from `GET /api/catalogue/search-box?q=` (same answer as the website's).
  `GET /api/catalogue` takes the filters: `q`, `pl` (place id), `f` (feature key, repeatable), `dev` (developer id), `bed`, `max` (price up to), `page`.
- Filters: one place (area or sub-area), features (all must match), one developer, bedrooms, price up to. Server rules: `services/projectRows.js filters()`.
- Cards, not a table: cover photo, name, developer, place and governorate, fact pills (from price, bedrooms, feddan, down payment, years), delivery,
  status badge, unit and plan counts. Same look as the website card (`web/views/catalogueList.js projectCard`).
- Paging: 20 per page, total count shown.

### A2. Project page
- Photo carousel on top (the project's shared photos, same carousel as the unit page).
- Facts: price from, size, bedrooms, lowest down payment, longest term, discount, delivery as written, other facts (consultant, operator, rental mandate),
  feature chips, place and governorate.

### A3. Add / edit project (managers only), built like add unit
- Three sections: Project and place · Numbers and prices · Developer and photos. Add walks them with the step bar and a fixed bar; edit shows all.
- Required `*`: project name and area. Every other label says (optional). Same rule as add unit.
- **Paste box** (free, no AI, no credits): `POST /app/catalogue/projects/read {text}` → `{ name, name_en, name_candidates, developer: {id,name}|{name,new}|{global_id,name,new}|null, place, features[], existing: {id,name}|null, fields: { area_acres, delivery_raw, delivery_year, status, price_from, down_pct_min, years_max, discount_pct, bedrooms[], property_types[] }, offers[], facts[], found[] }`.
  Fill the fields, show what was read, ask the broker to check. If `existing` is set, say the project is already in the catalogue and link to it.
  On the phone: `POST /api/catalogue/projects/read` (managers; same body and answer). Developer list: `GET /api/catalogue/developers/suggest?q=`.
- **Place = area or sub-area, never a compound.** Typing searches areas and sub-areas (`scope=areas`). Under the box show its parents and the **governorate**, read-only.
  A sub-area that is not on the list can be requested: name (and Arabic name), parent area (required). It is saved pending, usable by this agency only, and the
  project is filed under the parent until the CRM owner approves it, then it moves by itself. Send the same fields the website sends: `area_id`, `subzone_id`, `compound` (the new name) and `compound_new=1`, `compound_ar`.
- **Developer box**: search the agency's developers, then global names (names only); or type a new name (private to the agency).
  `GET /app/catalogue/developers/suggest?q=` → `{ items: [{ id, name, name_en } | { global_id, name, name_en }] }`. Send `developer_id`, or `developer_global_id`, or `developer_name`.
- Fields posted: `name, name_en, status, price_from, area_acres, down_pct_min, years_max, discount_pct, maintenance_pct, bedrooms[], property_types[], delivery_year, delivery_quarter, delivery_raw, notes, pin, feature[], features_other, paste_text` (the pasted message, kept for the server to read again), plus the developer and place fields above.
  Numbers accept Arabic digits and commas. The server answers `{ error: "invalid", field }` for a bad value.
- Photos: up to 10 on a new project, all shared, no AI. The AI sort ("Sort with AI") is a separate, explicit action on the project gallery, with its cost shown.

### A4. Do not break
Existing catalogue reads (`GET /api/catalogue`, `/api/catalogue/projects/:id`), plans, materials, phases, archive, clarify, price sheets, quick updates.

## B. Ask and the shared results (built)

### B1. One grouped search for Ask and the catalogue
`GET /api/ask/results?q=&sort=&page=&per=&drop=&pmin=&pmax=&amin=&amax=&dmax=&imax=&bed=` →
```
{ chips: [{ key, value }], dropped: [], filters: { … the filters in force … },
  sort: "best|cheap|pricey|small|big|down", page, pages, per_page,
  total_projects, total_options,
  projects: [{ id, name, name_en, developer, place, governorate, status, delivery,
               price_from, facts: [{ label, value }],
               offers: [{ type, area, floor, bedrooms, price, down, monthly, years, discount_pct }],   // matching offers, at most 5
               offers_total,                                                                              // how many match in all
               free_text,                                                                                 // when the project has no offers: the notes lines that fit, never invented
               client_text }] }                                                                           // what to send on WhatsApp
```
- Grouped per project. A project with units shows them; a project without details shows `free_text` and its facts.
- Sort by price (`cheap` / `pricey`), area (`small` / `big`), down payment (`down` = lowest first), or best match.
- Filters from the question become chips; each can be removed with `drop=place,area,price,down,inst`. The explicit filters above override.
- Pages of 10 (`per` up to 25). Show "N projects · M options", page numbers with a window (first, previous, current ±2, next, last).
- `GET /api/catalogue` returns project cards with the same fact fields (`price_from, area_acres, down_pct_min, years_max, bedroom_options, property_types, feature_keys, delivery_raw, cover_url, units, plans`), so one card component serves both lists.
  The sort names are `best, cheap, pricey, small, big, down`; `drop` also accepts `beds` and `features`; `dev` (developer id) narrows to one developer. The website's results page (`web/views/projectResults.js`) is the reference layout.

### B1b. Reading and the answer line
- `GET /api/ask/results` also returns `token` (send it back as `f=` on page, sort and filter links so the question is not read or logged again), `read: { source: "ai"|"parser"|"fallback"|"link", disagree: [] }`, `log_id` and `answer_line` (a short summary written from the results by code, free).
- `POST /api/ask` now returns `source: "ai"|"local"` and `log_id`. With `source: "local"` the AI was off, out of credit or failed, and `answer` is the line written from the data: show it with a note, not an error. Only when there are no matching projects do the old 402/503 errors still come back.
- New questions are read by the AI first and the parser second, both logged; follow the same rule on the phone: never read the same question twice (use `token`).

### B1c. Built since the first version (server side is done)
- **Photos.** `POST /api/catalogue/projects/:id/photos` (managers, multipart field `doc`, up to 10 JPG/PNG/WebP, no AI: all shared) is the upload twin you guessed. `GET /api/catalogue/projects/:id` now returns `images: [{ id, url, role: shared|layout|hidden, kind, mime, match_status, listing_ids }]` (shared first; hidden ones only for managers) and `cover_url`.
- **Sort with AI** (explicit, spends pages, show the cost): `POST /api/catalogue/projects/:id/gallery` multipart `doc` (+ `pages` for a PDF, + `sort=1`). Errors `{ error, left?, needed? }`: `OFF` (reading is off, a PDF needs it), `SORT_PDF` (a PDF needs sort=1), `ALLOWANCE` (402, pages left and needed). Also `POST .../gallery/:imageId` ({ role, units }) and `POST .../gallery/:imageId/delete`.
- **Why a project is listed.** Each result card has `matched: ["place","features","developer","price","area","bedrooms","down","installment"]`; show it as "Matches: …". New param `units=1` shows only projects with unit details. A project that matches nothing asked is never returned.
- **What the user does next.** `POST /api/ask/action { log_id, action: filter|sort|chip_drop|page|open|send, detail }` (204) after each tap, and `POST /api/ask/report { log_id, note }` for "Wrong results?" (409 if already reported). Use the `log_id` from the first results answer on every later page, sort and filter: pass it back as `sl` with `f` (the token), so nothing is read or logged twice.
- **Catalogue card.** The list and the results use one card; the catalogue list is the same search in browse mode (`GET /api/catalogue` keeps `projects.items` with the card fields).

### B2. Ask's answer
`POST /api/ask` is unchanged in shape. The server now answers from the new project rows (place with governorate, features, size, price from, bedrooms, down payment, term, discount, delivery, facts, offers) and says when they were read. Show `dataDates` as today.

## C. Screens (same structure as the website, for ease of use)
1. **Catalogue**: search box with chips, filter row (bedrooms, price up to), cards, count, pages; "New project" for managers.
2. **Project**: carousel, facts, offers, plans, files, units (as now), "Edit" for managers.
3. **Add / edit project**: section C of the website form (A3).
4. **Ask**: the question box, the answer card with data dates, then the grouped results (B1): chips, count, sort pills, filter row (price range, area range, max down payment, bedrooms), project cards with their offers or free text, WhatsApp button, pages.
Visual language as in section 5.1 of `docs/plans/unified-unit-box.md`: Cairo, 12 px fields, 16 px cards, 48 px inputs, 44 px touch targets, blue primary, no emoji in headings or buttons. Arabic and English, right to left.

## Done when
1. A pasted launch message fills the add-project form on the phone with the same results as the website for the same message (use `tests/fixtures/project-pastes.js` in the server repo: three real messages).
2. The catalogue and Ask list show the same grouped cards; sort, filter and pages work and the counts are right.
3. Tests added or updated in the app's own suite; run them and the type check; report anything that fails.
4. Reply with what you changed, what you could not match, and any server gap (do not edit the server repo).
