# Parser consolidation: one reading layer, parser first where AI is not needed

Status: draft for review, 2026-11-17
Scope: `domain/searchQuery.js`, `domain/sheetImport.js`, `domain/sheetMixed.js`, `domain/chatListing.js`, `domain/leadIntake.js`,
`domain/catalogueUpdate.js`, `domain/projectPaste.js`, `domain/priceSheet.js`, `domain/planReading.js`, `lib/text.js`,
`lib/listingExtract.js`, `services/search.js`, `services/followUpDrafts.js`, and the app copy in `packages/shared`.

## 1. Goal

Strengthen the rule parsers until they read Egyptian broker language as well as the AI does, so that AI is used only for
what a parser can never do: voice notes, flyers, photos and PDFs. Search and Ask quality is not negotiable: their AI path
does not change in this plan.

## 2. Decisions taken

| # | Decision | Owner answer |
|---|----------|--------------|
| D1 | Search and Ask filters stay **AI-first**. The parser runs in the background and is compared with the AI, as today. No flip in this plan. | confirmed |
| D2 | Ask answers from **catalogue data only**. The web-search path in `services/assistant.js` stays **switched off**. It is not deleted here. | "off" |
| D3 | Add unit, WhatsApp chat and Excel are **parser-primary**. AI only for voice notes and photos. | confirmed |
| D4 | Leads, catalogue updates, deals, pasted launch messages, price sheets and payment plans in Excel, CSV or text are **parser-primary**. AI only for voice and for PDFs and photos. | confirmed |
| D5 | **Follow-up message drafts become templates.** No AI call. Side effect: the draft no longer imitates the broker's own tone. | "templates" |
| D6 | Before AI is removed from add-unit text: **100% on price, area, bedrooms and bathrooms, 98% on every other field**, measured on the golden set (section 5). | "as recommended" |
| D7 | **Empty beats wrong.** In a parser-primary feature a value the parser is unsure of stays empty and is shown in red for the person to complete. | design rule |

## 3. What uses AI today, and the target

| Feature | AI call today | Target |
|---|---|---|
| Search | `search_parse`, AI-first (`SEARCH_AI_FIRST`, daily cap) with the parser beside it | unchanged (D1) |
| Ask filters | `search_parse` through `projectSearch.js` | unchanged (D1) |
| Ask answer | `assistant` | unchanged; catalogue data only (D2) |
| Add unit | `listing_extraction` | parser; AI for voice and photos only |
| WhatsApp chat import | parser first, `listing_extraction` for posts it cannot read | parser only for text |
| Excel import | none | none |
| Lead from text | `lead_extraction`, `lead_update` | parser; AI for voice only |
| Catalogue update sentence | rules first, `catalogue_update` fallback | rules only; AI for voice only |
| Payment plans from Excel or CSV | `plans_read` | rules |
| Price list or plans from PDF or photo | `price_list_read`, `plans_read` | AI stays |
| Brochure, gallery, vision curation | `brochure_*`, `gallery_read`, `vision_curation` | AI stays |
| Voice transcription | `audio_transcription` | AI stays |
| Follow-up draft | `follow_up_draft` | templates (D5) |

## 4. Findings that drive the plan

Measured on 2026-11-17 with probe scripts (cases written by hand, not taken from logs; the 704 existing unit tests all pass):

- **Money is read by 9 separate functions that disagree.** On 44 Egyptian amount strings the share read correctly was:
  search 28, `lib/text.js parseMoney` 25, `parseEgyptianPrice` 18, `sheetImport.money` 13, `sheetMixed.priceText` 13,
  `chatListing` 10. A single prototype reader read 56 of 56 on a larger list.
- **Confident wrong values**, not only misses: `٣ ونص مليون` read as 1M, `5 مليون الا ربع` as 5M, `7 مليون و 200` as 7M,
  `بـ 3.5 م` as 5M, `1,5 مليون` as 15M in Excel, `3 مليون و 750 الف` as 3M in chat, `450 sqm land, 380 BUA` as 450,
  `استوديو 60م 15 الف` as price 60,000.
- **Search** 64 of 91 phrases; misses include Franco (`tagamo3`, `re7ab`), places missing from the static list, `غرفة وصالة`,
  `مساحة 150`, `تاني دور`, `كور اند شيل`, and wrong readings of `شقة ارضي` (adds type land) and `سيمي فينشد`.
- **WhatsApp posts** 6 of 20 fully right.
- Three copies each of the finishing words and the furnishing words, three Arabic number-word tables, two edit-distance
  functions, many digit converters.

## 5. Plan

### Phase 0: safety net (no behaviour change)
1. Snapshot the output of every parser on all existing test inputs and the 137 cases in `tests/eval/search-egyptian-cases.json`.
2. Build the golden corpus: real search texts and both readings from `search_log`, chat posts and corrections from
   `chatParseLog`, plus the hand-written probe cases. Each case holds the text and the expected fields.
3. Build the compare harness: old output against new output on the corpus, every difference listed as fix or regression.

Exit: harness runs in CI; baseline numbers recorded.

### Phase 1: shared readers
New modules under `domain/read/`, pure, no requires beyond the normalizer. The old functions become thin wrappers so no
caller changes at once.

| Reader | Replaces |
|---|---|
| amount (million, thousand, half, quarter, "الا ربع", "و 200", number words, `8.500.000`, `5.5م`) | 9 money readers |
| number words, ordinals, digits | 3 word tables, digit converters |
| rooms, area (land versus built-up), floor | `searchQuery`, `sheetMixed`, `chatListing` |
| finishing, furnishing | 3 copies each |
| sale, rent, market | `searchQuery`, `sheetImport`, `chatListing` |
| Franco and Arabic-letter English | search only today |

The app copy in `packages/shared` follows; `tests/parity` guards it.

Meaning stays with the caller: a bare price in search is a ceiling and a count a minimum; in a listing they are exact. The shared
reader returns the token value and whether it had a unit; the caller applies the meaning.

Exit: harness shows only intended fixes, zero regressions; unit tests for the readers.

### Phase 2: parser-primary writers
1. Excel and chat import switch to the shared readers first (their wrong values reach the review screen today).
2. Chat import stops calling `listing_extraction` for text.
3. Add unit: parser reads the text. For a few weeks the old AI result is computed beside it and compared (as the chat log
   already does). AI is removed from add-unit text only when the D6 targets are met. AI stays for voice and photos.

Exit: D6 targets met on the golden set; red-cell rate in review reported.

### Phase 3: leads, catalogue, plans, deals, follow-ups
1. Lead from text: name and phone from existing rules, budget and need through the search reader.
2. Catalogue update: remove the `catalogue_update` fallback.
3. Plans and price sheets from Excel, CSV and text: rules. PDFs and photos stay AI.
4. Fix money in `projectPaste`, `projectNotes`, `leadImport`, `deals`.
5. Follow-up draft: replace the AI call with templates filled from the lead record (first name, request, last contact, stage), in Arabic and English.

Exit: each feature's tests pass; no AI call remains for text input outside voice.

### Phase 4: search and Ask parser, background only
Users see no change. Fix the silent wrong values and the misses in section 4. An unread word next to a number marks the
reading unsure. Add a per-filter agreement report from `search_log` for the owner.

Exit: agreement per filter reported weekly. Whether to ever flip search to parser-first is a separate decision, later.

### Phase 5: review loop
Each week, disagreements and red cells from the logs become golden cases, then fixes, then a harness re-run.

## 6. Risks

| Risk | Control |
|---|---|
| A shared reader changes a value a caller depends on | Phase 0 snapshots; thin wrappers; harness diff before every switch |
| A parser reads confidently wrong | D7; unread-word rule; golden-set gate before removing AI |
| Search or Ask quality drops | D1; no change to their AI path in this plan |
| Template follow-ups feel less personal | Accepted in D5; templates are editable by the broker before sending |
| Golden set is not representative | Seeded from real logs, grown weekly (Phase 5) |

## 7. Open points

- Confirm in the database that the Ask web-answer switch is off for every agency (D2). Not checked in this assessment.
- The probe cases were hand-written. The real agreement rates need the logs in Phase 0.
