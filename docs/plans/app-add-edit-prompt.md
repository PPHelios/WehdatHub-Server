# Prompt for the WehdatHub-App chat: bring the add/edit unit screen up to the website

Paste this into a Claude Code chat opened in `D:\code\WehdatHub-App`. The server repo is at `D:\code\WehdatHub-Server`
(read-only for you here; it already has everything below, so no server change is needed).

---

The website's add/edit unit form was changed (server commits `2b8ad03`, `9e6c317`, `d35435a`, `a6d9554`, `44bc468`, `8765fa4`).
Make `AddUnitScreen` (add and edit) behave the same. Read these first, they are the source of truth:

- `D:\code\WehdatHub-Server\docs\plans\unified-unit-box.md` (sections 4, 5, 9)
- `D:\code\WehdatHub-Server\web\static\unitBox.js` (the box), `web\static\unitFields.js` (field rules, description draft),
  `web\views\unitForm.js` (markup and order)
- `D:\code\WehdatHub-Server\domain\unitBox.js`, `domain\fieldRules.js` (`FIELD_TYPES`), `domain\features.js`, `API_CONTRACTS.json`

First sync this folder with the repo's main branch (it is behind). The working tree already has uncommitted changes (photos,
`UnitScreen.tsx`, `usage.ts`): leave them alone and do not commit or discard them.

Where things are: `apps/mobile/src/screens/AddUnitScreen.tsx` (add and edit), `apps/mobile/__tests__/AddUnitScreen.test.tsx`,
`PlaceInput.test.tsx`, `unitEdit.test.tsx`. Update those tests for the new box.

## 1. One box for place and features (replaces the compound, area, sub-zone boxes and the feature checkbox grid)

- One text box. Typing calls `GET /api/places/box?q=&lang=` → `{ items: [place suggestions…, { kind:"feature", key, label }…] }`.
  Places first, then features. Place items carry `kind` (compound / subzone / area), `id`, `label`, `path`, `zones[]`.
- **One place chip** (required). A second place replaces the first. Under the box show its parents and zones, read-only
  ("القاهرة الجديدة › التجمع الخامس · المربع الذهبي").
- **Feature chips** with × to remove. Free text that matches nothing becomes a grey "other" chip (max 20, each max 60 characters).
- **Chips sit under the typing line, not inside it.**
- **Pasted text** (in the box or the description) → `POST /api/places/box/resolve {text}` → `{ place, features:[{key,label}] }`.
  No AI, no credits. The "Fill from text" and voice buttons stay as they are and fill the other fields.
- Unknown place: keep the existing "add new compound" path (name, Arabic name, maps link; district and city only there).
- The box writes the same fields the form always sent: `compound`, `area_id`, `subzone_id`, `feature[]`, `features_other`,
  `compound_new`. Nothing in the save, review or server checks changes. Look at what `web/static/unitBox.js` writes and do the same.
- The phone's offline places copy (`GET /api/places/list?since=`) is still valid for the place part; the feature list can come
  from `domain/features.js`.
- Editing a unit: show its current place as the chip and its stored features as chips (use the unit's `compound`/`area_id`/
  `subzone_id` and `feature_keys`).

## 2. Field rules by sale/rent and unit type

Same as `web/static/unitFields.js`, which reads rules off the markup:

- **Sale** hides the rent period. **Rent** hides delivery and payment (section off). Hidden fields are not sent.
- The price label is "Monthly rent" for rent and "Price" for sale.
- Size fields by type, from `FIELD_TYPES` in `domain/fieldRules.js`: land area, garden area, roof area, floor. A field is shown
  for its types, and always when it already has a value.
- Garden and roof areas add their feature (garden / roof).
- New unit type **roof** (روف): add it to the type list and the labels. It implies the "roof" feature (`withTypeKeys`).
- If the app keeps its own copy of these tables, copy them; if it can read them from the API, prefer that. Do not invent new rules.

## 3. Layout

- Single column on phone, tablet and desktop. Same four sections in the same order as the website (unit and place · size and
  price · delivery and payment · owner, photos and save). Add walks them with a step bar and a fixed Back / Next / Save bar;
  edit shows all of them. A step whose sections are all off is skipped.
- Field names, labels and order match the website. Arabic and English, right-to-left.
- Visual language from section 5.1 of the plan: Cairo font, 12 px fields, 16 px cards, 48 px inputs, 44 px touch targets,
  blue primary, no emoji in headings or buttons.

## 4. Client description

The description for clients is written from the unit's own fields while it is empty or still the draft. Once the broker edits it
by hand it stays theirs. A "write it again" button takes the draft back. See `unitFields.js` (`data-draft`, `data-draft-again`)
and `domain/describe.js`.

## Do not break

- Photos (up to 15, order, cover, delete, direct upload), duplicate check and "Save anyway", save key (no double save),
  edit version check, live review with blockers and warnings, owner and lead code, voice, per-step server check.
- The parity checklist in section 9 of the plan: every line must still work.

## Done when

1. Typing and pasting in the box gives a place chip and feature chips on a phone, and the saved unit has the same fields the
   website saves for the same input.
2. Sale hides rent fields, rent hides delivery and payment, and the size fields follow the type, with the same results as the
   website for the same unit.
3. Tests added or updated in the app's own suite; run them and the type check, and report anything that fails.
4. Reply with a short list of what you changed, what you could not match, and any server gap (do not edit the server repo).
   Check what the website's browser test `tests/browser/unit-area-box.test.js` covers and cover the same cases in the app.
