# Unified unit box: add and edit on web, app and Telegram

Status: draft for review, 2026-11-15
Design: https://claude.ai/artifact/7YthVEp5zjCGt374Q2oDEj ("WehdatHub new look mock", row "Unified box"): laptop add,
laptop edit, phone box while typing, phone request-new-place sheet, Telegram review card
Data: `wehdathub-compounds-and-locations-2026-11-15-v6.xlsx` → migrations 114 and 115

## 1. Goal

Adding or editing a unit uses **one box** for where the unit is and what it has. The broker types or pastes; the box turns it
into one place chip (compound, sub-area or area) and feature chips (بحري، روف، فيو لاجون…). Parents and zones (New Cairo,
Golden Square) are shown, never picked. No more separate compound / area / sub-zone boxes and no 38-checkbox feature grid.

The same rules, the same API and the same screen structure serve the website, the phone app and the Telegram bot. A change to
the rules is made once, on the server, and reaches all three.

Nothing the add/edit form does today is dropped (section 9 is the checklist).

## 2. Decisions taken

| # | Decision | Why |
|---|----------|-----|
| D1 | Keep `areas` and `map_places`; add `place_zones` and a `listings.place_ids` projection. No new `locations` table. | The two tables already are the location graph (area → sub-zone → compound). A merge would touch ~44 files for no user-visible gain. |
| D2 | Project **ids**, not name slugs. | A rename or a new alias needs no re-sync. Only a move (new parent, new zone) does. |
| D3 | The projection is computed in shared JS (`domain/`), not a database trigger. | All matching rules already live in tested JS; web, app and Telegram save through the same server code. |
| D4 | A broker's new compound or sub-area can be used at once by **their own agency**, and stays hidden from other agencies until the owner approves or merges it. | Never blocks a broker; never pollutes other agencies' lists. |
| D5 | Web and app share **logic and structure**, not UI code. | The web is server-rendered HTML, the app is React Native. Both render the same API answers into the same layout. |
| D6 | Tags in v6 become **"also in" links to area rows**, not a separate zone list. | 10 of the 18 v6 tags are already sub-areas (Golden Square, North 90th, Sadat Axis…). One record per place keeps one name to search and to fix. |

## 3. Data model

### 3.1 What exists (unchanged)

- `areas` — the tree: area (no parent) → sub-zone → sub-zone, at most 3 levels; names, aliases, `place_type`, governorate, pin.
- `map_places` — compounds: names, aliases, pin, developer, `area_id`, `subzone_id`, `approved`, `verified`, project notes.
- `listings` — keeps `place_id`, `compound`, `compound_key`, `area_id`, `subzone_id`, `district`, `city`. Every read path that
  uses them keeps working. From now on the server writes them from the one pick; the form no longer sends them.

### 3.2 New

```sql
-- 114: a compound's extra areas ("also in"): Golden Square, South 90th, Sadat Axis… beyond its own area and sub-zone.
CREATE TABLE place_zones (
  place_id uuid NOT NULL REFERENCES map_places(id) ON DELETE CASCADE,
  area_id  uuid NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  source   text NOT NULL DEFAULT 'manual',   -- 'seed' (v6) | 'manual'
  PRIMARY KEY (place_id, area_id)
);

-- Phase 1 (with the box):
ALTER TABLE listings ADD COLUMN place_ids uuid[] NOT NULL DEFAULT '{}';
CREATE INDEX listings_place_ids ON listings USING gin (place_ids);
ALTER TABLE map_places ADD COLUMN proposed_agency_id uuid;   -- D4: pending, visible to this agency only
ALTER TABLE map_places ADD COLUMN amenities text[] NOT NULL DEFAULT '{}';  -- compound amenities (pool, gym…), see 4.4
```

`listings.place_ids` = the picked place + every area above it + its zones (and the areas above those zones). Example, a unit in
Mivida: `[mivida, 5th-settlement, new-cairo, golden-square]`.

### 3.3 Keeping the projection true

- **Pure:** `domain/placeGraph.js` → `placeIds(pick, { places, areas, zones })`.
- **On save:** the save sets `place_ids` (and `place_id`, `area_id`, `subzone_id`, `compound`, `compound_key`) from the pick.
- **On graph edits:** approve, merge, move to another parent, add/remove a zone or delete a place each call
  `Projection.refresh(db, ids)`. That is one `UPDATE listings … WHERE place_id = ANY($1) OR area_id = ANY($1) …`.
- **Safety net:** the nightly job rebuilds every agency's projection and logs any row that changed.

## 4. The box

### 4.1 What the broker sees

```
┌ المكان والمميزات * ─────────────────────────────────────────────┐
│ [📍 ميفيدا ×]  [بحري ×] [روف ×] [فيو لاندسكيب ×] [مدخل خاص؟ ×]    │
│ اكتب كمبوند، منطقة، أو ميزة…                                      │
└──────────────────────────────────────────────────────────────────┘
  القاهرة الجديدة › التجمع الخامس · المربع الذهبي          (read-only)
```

- **One place chip, required.** It holds a compound, a sub-area or an area. A second place replaces the first and the box says
  so ("بدّلنا ميفيدا بـ هايد بارك"). The context line under the box shows its parents and zones, read-only.
- **Feature chips** come from the feature dictionary (`domain/features.js`). Tap × to remove one.
- **Other chips** are free text that matched nothing (today's "other features" field). They are grey and marked "مش في القائمة",
  at most 20, each at most 60 characters.
- **Suggestions while typing**, in two groups, Places (compounds, sub-areas, areas, zones) and Features. They match Arabic,
  English and aliases (the existing `placeSuggest` plus the feature dictionary). Enter or a tap picks one.
- **Paste a message** into the box, or into the description above it, and the box resolves locally and free: the place and the
  features become chips at once. The **✨ Fill from text** and **voice** buttons stay as today (AI, credits shown) and fill
  the other fields: price, size, bedrooms, payment and so on.
- **No match for a place** → "＋ اطلب مكان جديد" opens a mini form:
  - kind: compound or sub-area (never a top-level city)
  - parent area: required, a search box over approved areas
  - name EN (required) / AR, Google Maps link (optional, checked against the Egypt box)

  It is saved as pending, usable at once by the broker's agency (D4), and goes to the owner's review queue (approve / merge as
  alias / reject — the existing `placeReview`, keeping its limit of 5 per broker per hour).
- **Ambiguous names** (Cairo-Suez Road under 3 cities, Dahshour Link under 2) are suggested with their parent ("طريق السويس ·
  مدينة نصر"), so the pick is always one row.

### 4.2 One resolver for everyone

`domain/unitBox.js` (pure, tested) is used by the web route, the app API and the Telegram draft:

```
resolve(text, { places, areas, zones, features }) →
  { place: {kind, id, name_ar, name_en, context_ar, context_en} | null,
    candidates: [...up to 5 when the place is unclear],
    features: ["north_facing", "roof", ...],
    other: ["غرفة مربية كبيرة"],
    rest: "text that is not place or feature" }
```

Rules (in order):
1. The longest place name or alias wins. Compounds beat areas when the same words name both ("Mivida").
2. Feature words are matched with the strict tagging list (`syn`, whole words) — see 4.4.
3. A place word inside a feature phrase is not a place ("فيو النادي" is a view, not a club area).
4. Two different places in one text → the most specific one is the pick; the others become `candidates`.

### 4.3 API (one contract, web + app)

| Call | Today | After |
|------|-------|-------|
| `GET /api/places/suggest?q=` | places and areas | + zones, + features (`kind:"feature"`) |
| `GET /api/places/list?since=` | phone's offline copy of places/areas | + zones, + feature dictionary, same version key |
| `POST /api/units/box` `{text}` | — | `resolve()` answer (4.2) |
| `POST /api/units/review`, `/api/units`, `/api/units/:code/edit` | fields incl. `compound`, `area_id`, `subzone_id`, `feature` | **`place`** (`compound:<uuid>` / `area:<uuid>` / `pending:<uuid>`), `feature[]`, `features_other` |

The website calls the same handlers under `/app/...` (session cookie instead of a token), as it does today.

**Old app builds keep working.** The server still accepts `compound` + `area_id` + `subzone_id` and turns them into a `place`
with today's matching (`compoundResolve`). This is removed only when no app build older than the box is in use (the usage log
shows the build).

### 4.4 Feature dictionary changes (`domain/features.js`)

**Tagging precision:**
- Remove bare `north`/`south` (they matched "North 90th").
- Remove bare `مطبخ`/`kitchen` (they matched every room list).
- Remove bare `club`, `لاجون`, `lagoon`, `لاندسكيب`, `landscape`.

**Split each feature's words in two:**
- `syn`: strict, for tagging listing text.
- `query`: lenient, for the search box. A buyer typing "kitchen" or "lagoon" still filters.

**New unit features:**
- orientation: `double_face`
- layout: `guest_bathroom`, `office_room` (only "غرفة مكتب" / "office room", never bare "مكتب"), `private_entrance`
- view: `view_golf`, `view_nile`
- equipment: `central_ac`, `intercom`

**Compound amenities** (`pool`, `gym`, `clubhouse`, `kids_area`, `generator`):
- They live on the compound (`map_places.amenities`), not the unit, so a unit cannot contradict its compound.
- They are searchable through the compound.
- They show on the unit as read-only "في الكمبوند" chips.

**Not added:** `living_room` (every unit has one) and `main_street` as a view (a main street is not a view).

**Unchanged:**
- Matching normalises ى/ي, أ/ا, ة/ه already, so no spelling duplicates are needed in the lists.
- Stored `feature_keys` stay valid; no key is removed.
- The search text is rebuilt once after the change.

## 5. Screens: one structure for web and app

Both screens have the same four sections in the same order with the same field names. **Add** walks them one at a time;
**edit** shows all of them, with a section list (laptop) or jump chips (phone) and a save bar that stays in view.

| Step | Section | Contents |
|------|---------|----------|
| 1 | الوحدة والمكان / Unit and place | Paste or voice (✨ fill, 🎙 record, 📎 file, credits shown) · **the box** · sale/rent · type · resale/primary · code (add only) |
| 2 | المساحة والسعر / Size and price | price (accepts "8.5 مليون") · currency · rent period · size m² · bedrooms · bathrooms · floor · finishing · furnishing · land / garden / roof (villa, duplex, twin, townhouse only) |
| 3 | التسليم والدفع / Delivery and payment | ready now · year · quarter · resale installments tab · primary tab (cash price, maintenance, project, developer, 3 plans) |
| 4 | المالك والصور / Owner, photos and save | owner, phone, "use phone as name", lead code · more details (commission, co-broker, unit no., address, pin) · notes · client description · photos · review · save |

**Laptop:** the steps run left to right in a header, the form sits in the main column, and a right rail holds the **live
review**: blockers (tap to jump), warnings, the unit preview card, and the save button.

**Phone (web and app):** one column, a step bar at the top, and a fixed bottom bar (Back / Next / Save).

### 5.1 Visual language (the "new look" canvas)

- **Type:** Cairo 400/600/700/800. Labels 15/600, inputs 16, section titles 18/700.
- **Colour:** ground `#F4F6F9`, cards `#FFFFFF` with radius 16, text `#1B2430`, muted `#5B6878`, line `#C9D2DC`. Primary
  `#1D70B8` (pressed `#155A96`), clay accent `#C45A30`. Success `#E8F5EC`/`#1E6B3A`, error `#FBEAEA`/`#8E2A20`. Dark-mode tokens
  follow the same names.
- **Controls:** inputs 48 px tall, radius 12. Touch targets ≥ 44 px. Primary buttons are filled blue, secondary ones outlined.
- **Icons:** inline stroke icons, **no emoji in headings or buttons**. This is the biggest single "professional product"
  signal.
- **Section headers:** a step number, a title and a one-line hint.
- **Chips:**
  - place chip: blue fill with a pin icon
  - feature chip: light blue
  - other chip: grey
  - compound-amenity chip: outlined and read-only
- **Feedback:** errors are shown next to the field and in the review rail, never only at the top.

## 6. Telegram (and WhatsApp)

The bot already works as text/voice/photos → draft → "done" → review card. The card gains two lines and two buttons:

```
📍 ميفيدا · القاهرة الجديدة › التجمع الخامس · المربع الذهبي
✨ بحري · روف · فيو لاندسكيب
[📍 غيّر المكان] [✨ المميزات] [✅ احفظ] [✏️ افتح الفورم]
```

- **📍 Change place:** the bot asks for the name and answers with up to 5 candidates as buttons, plus "＋ مكان جديد" (which asks
  for the parent area the same way).
- **✨ Features:** a keyboard of the unit's chips with ✕ to remove, plus "type more to add".
- **✏️ Open form:** opens the same web form inside Telegram (Mini App), as today.
- **WhatsApp:** gets the same lines, with numbered replies where buttons are not available.

All of it calls `unitBox.resolve()` in-process. No logic lives in the bot.

## 7. Effect on search

**Today:**
- An area word scopes `area_id`/`subzone_id`, with the subtree expanded at query time (`services/areaSearch.js`).
- A compound word matches `compound_key` text.
- Zones do not exist. "Golden Square" finds units filed under the Golden Square sub-area only, and misses most of the 24
  compounds v6 tags as Golden Square (they are filed under 5th Settlement or South 90th).

**After:**

| | Today | After |
|---|---|---|
| "New Cairo" | area_id = New Cairo, or subzone under it | `place_ids && {new-cairo}` (same result, one index) |
| "Golden Square" | sub-area only (misses tagged compounds) | every unit in the sub-area **and** in any compound linked to it |
| "Mivida" | `compound_key = 'mivida'` (text) | `place_ids && {mivida}`; a renamed or aliased compound still matches |
| "Banafseg 1" | subzone subtree | `place_ids && {banafseg-1}`, no bleed into Banafseg 2 |
| "طريق السويس" | first matching area only | all 3 Cairo-Suez Road rows (a shared name means all of them) |
| "north facing" | also matched units near "North 90th" | only units really tagged north facing |
| "kitchen" | matched every room list | buyer words still filter (`query` list); units are tagged only by real phrases |

**Semantics:** several place words in one search are **OR**, the same as today's single `ANY` list. Place words and
features are **AND**.

**Fallbacks:**
- Units with no pick (old rows, `needs_fix`) have an empty `place_ids`, so the search keeps today's area/`compound_key`
  conditions as an `OR`.
- Old saved searches and shared links carrying `area_scope` keep working.

**Speed:** one GIN containment test replaces the subtree expansion and the text match. It is per agency, a few thousand rows,
well under a millisecond.

**Risks and checks:**
- **Projection staleness:** refreshed on each graph edit, plus a nightly rebuild.
- **Changed counts:** the nightly search check (`tests/eval`) gains the zone and false-tag cases above. Result counts before and
  after are compared on the live data before the old path is switched off.

## 8. v6 data: what migrations 114 and 115 do

`114_place_zones.sql` creates `place_zones`. `115_location_v6.js` loads `db/data/location-v6-2026-11-15.json` (made from the
workbook). Like 111 it is safe to re-run, skips and logs a failing row, and keeps backups in `*_backup_115`.

**Changes it makes:**

| Change | Count | Rule |
|--------|-------|------|
| Compounds moved to a deeper sub-area | 17 | `area_id`/`subzone_id` from the v6 path; their units follow |
| Compound pins | 38 | v6 pin, unless the owner confirmed that pin in the pin review after 2026-11-15 (`pin_checked_at`); those are kept and logged |
| Area pins ("trap" fixes: New Cairo, Abu El Houl, Al Karnak, Narges 1 Villas) | 4 | overwritten (111 only filled empty pins) |
| Aliases | 180 | v6 list ∪ old names ∪ owner-added aliases, minus any alias that names another compound (the "cross-contaminated" ones) |
| Zones (v6 `tags`) | 18 tags on 119 compounds | linked to the matching sub-area under the compound's own city; 6 missing ones created (AUC Area, Middle Ring Road, Ain Sokhna Road under New Cairo; Cairo-Alexandria Desert Road under Sheikh Zayed; Cairo-Suez Road under Madinaty and New Heliopolis); a link to the compound's own sub-area is skipped |
| Developer names | 264 | v6 name (already canonical) |
| `verified` flag | 28 false | only orders matching; nothing is hidden |
| Duplicate `New Cairo > MU23` | 1 | merged into `New Capital > MU23` (units and compounds follow) |

**Not imported, on purpose:**
- **North/South Investors Extension:** v6 lists them as separate sub-areas again, with the same pin and Google id as Northern
  Investors Area. 111 made them aliases, and that stays. Their 3 compounds go to Northern Investors Area.
- **Bad alias text:** the old Arabic name of Double Two Tower contains Korean letters ("دابل تو 타ور"). Any alias with letters
  that are neither Arabic nor Latin is dropped.
- **Generated project notes:** 244 project notes are generated text like "located in New Cairo > 5th Settlement". Only the 22
  notes with a real source (web-verified or written by you) are loaded, as in 111.
- **Bad pins on 14 locations:** 10 locations were not found and 4 are out of bounds, so their pins are left empty.

**Left for you to decide (not blocking):**
- **Ambiguous roads:** 6 compounds sit under the ambiguous road rows (Cairo-Suez Road ×3, Dahshour Link ×2). Should those
  roads become zones, with the compounds moved under their real sub-area?
- **Unverified developers:** 138 of 141 developers are unverified. A global developer list (today `developers` is per
  agency) is out of scope here.

## 9. Parity checklist (nothing dropped)

Each line must still work on the web after the change. The app column says where the app stands.

| # | Function | Web | App |
|---|----------|-----|-----|
| 1 | Fill from pasted text (AI, credits shown) | kept, step 1 | kept |
| 2 | Record voice / upload voice files (credits shown) | kept | kept |
| 3 | Code on add, refused at the first Next if used | kept | kept |
| 4 | Sale/rent, type, resale/primary | kept | kept |
| 5 | Compound picked from the list brings its area | **box** | **box** |
| 6 | Area or sub-zone without a compound | **box** (area chip) | **box** |
| 7 | Unknown compound: did-you-mean, add as new (area, sub-zone, district, city, AR name, maps link) | **box** "request new" (parent required; district/city derived from the parent) | same |
| 8 | Owner review of new places (approve / merge / reject, 5 per hour) | kept, plus agency-visible pending (D4) | same |
| 9 | Price with "8.5 مليون", currency, rent period | kept | kept |
| 10 | Size, bedrooms, bathrooms, floor, finishing, furnishing | kept | kept |
| 11 | Land / garden / roof for villa types; villa clears floor, sets BUA | kept | kept |
| 12 | Ready now, delivery year and quarter | kept | kept |
| 13 | Resale installments (paid, remaining, amount, frequency, last) | kept | kept |
| 14 | Primary: cash price, maintenance % and terms, project, developer, 3 plans | kept | kept |
| 15 | Feature checkboxes | **box chips** | **box chips** |
| 16 | Other features (free text) | **box grey chips** | same |
| 17 | Furnishing ↔ furnished/kitchen/AC features stay consistent | kept (server rule) | kept |
| 18 | Client description | kept | kept |
| 19 | Owner name, phone, "use phone as name", lead code list | kept | kept |
| 20 | Commission, co-broker, unit no., address, pin | kept (collapsed) | kept |
| 21 | Notes | kept | kept |
| 22 | Photos: up to 15, drag/arrows order, cover, delete, WhatsApp zip, preview, "ordered myself" (no AI order), direct upload | kept | kept |
| 23 | Live review: blockers (tap to jump), warnings + "I checked" gate, what changed (edit), preview | kept, right rail | kept |
| 24 | Duplicate unit → "Save anyway"; catalogue match notice | kept | kept |
| 25 | Save key (no double save), "is it saved?" check, save report | kept | kept |
| 26 | Edit: version check (no lost update), cancel | kept | kept |
| 27 | Per-step server check on Next | kept | n/a (one screen today; four sections after) |
| 28 | Telegram Mini App main button | kept | n/a |
| 29 | Arabic/English, right-to-left | kept | kept |
| 30 | Old app builds sending `compound`/`area_id`/`subzone_id` | accepted | — |

## 10. Phases

1. **Data (now):** migrations 114 (`place_zones`) and 115 (v6 import), with tests. Applied on the next deploy
   (`migrateOnBoot`).
2. **Server (phase 1):**
   - `place_ids` and its backfill
   - `domain/placeGraph.js` and `domain/unitBox.js`
   - `POST /units/box`
   - features dictionary changes with the `syn`/`query` split
   - search on `place_ids` with fallbacks
   - nightly rebuild
   - eval cases
3. **Web (phase 2):** the new add/edit page (box, four sections, review rail, new look), behind a per-agency switch until the
   browser tests pass. Then the switch goes.
4. **App (phase 3):** the same box and sections in `AddUnitScreen`. First sync the local `WehdatHub-App` folder with the repo's
   main branch (it is behind).
5. **Telegram (phase 4):** the review card lines and buttons.

## 11. Tests

- `domain/unitBox` and `domain/placeGraph`: table tests (Arabic, English, aliases, ambiguous roads, the false-tag cases from
  4.4).
- Migration 115: the same pattern as `tests/unit/location-import.test.js` (counts, re-nesting, zones, investors stay merged, a
  second run changes nothing).
- Web: the form sends `place` and features; edit round-trips; the old field names are still accepted; browser test of the box
  (type, pick, remove, request new).
- Search: zone, roll-up, no bleed between Banafseg 1 and Banafseg 2, `needs_fix` fallback.
