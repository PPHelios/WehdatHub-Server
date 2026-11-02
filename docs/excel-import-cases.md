# Excel import: every case that can raise an error, and what happens

Written from the NCH "RENT - All compounds" workbook (29 tabs, 3,751 rows, 26 visible tabs, 3,720 unit rows) and from the formats other agencies are likely to send. A case is **auto-fixed** (no question asked, shown on the review when it changes something), **batch-fixed** (one decision on the review page applies to every row it fits) or **flagged** (the row stays out of the import, with its reason and an edit form that asks only for what is missing).

| Case | Real example | Handling | What the person sees |
|---|---|---|---|
| Header names with typos or other names | `descibation`, `deatils`, `number`, `name`, `feedback` | Auto-fixed | Columns just work |
| Header row missing an empty column (every name after it sits one column left) | New Cairo Compound tab | Auto-fixed: headers are checked against what the columns hold and moved back | Nothing; the tab shows as read correctly |
| No header row at all | A tab starting straight with data | Auto-fixed: columns recognised by content (phone, code, type, price, area, rooms, long text, names) | The tab list says it was read by content |
| Header cell empty but the column has data | Owner name column with no title | Auto-fixed by content | Nothing |
| Many tabs, one per compound | 26 tabs | Auto-fixed: all tabs are read in the browser; the tab name is the compound when the sheet has no compound column | Tab chips with their counts; filter by tab |
| Hidden or empty tabs | `Sheet103` | Skipped, listed | Listed as skipped |
| Sale or rent only in the file or tab name | `RENT - All compounds.xlsx` | Auto-fixed from the name; if neither says it, **batch** (all rent / all sale) | A button with the count |
| Facts together in one cell | `2 Bedrooms (1 master) / 3 Bathrooms`; `land 600 m / built up 244 m` | Auto-fixed: rooms, built-up area, land area read; the original text is kept in the notes | Nothing unless the row is wrong |
| Facts inside the description | `fully finished / kitchen / ACs` | Auto-fixed: finishing and features read with the app's vocabulary, only when the sheet has no column for them | Shown on the unit line |
| Price with words around it | `60k negotiable`, `25k/2month insurance` | Auto-fixed: the amount is the price, the words go to the notes | Nothing |
| Several prices in one cell | `long 90k / short 100k / day 6k` | **Batch**: use the long-term or monthly price, or the first; a daily price is never used | A button with the count |
| Prices in dollars | `3000$` | **Batch**: one rate for all of them; the original is kept in the notes | A rate box with the count |
| A word where the price should be | `wait price`, `rented`, `after eid` | Flagged, with what the cell says | Reason `Invalid price: «wait price»` and the edit form |
| Phone number forms | `1069985171`, `+20 100…`, `1001222400/ 1275615557` | Auto-fixed: 0 added, first number is the owner's, the others go to the notes | A note only when the number is not an Egyptian mobile |
| Code written with spaces, case or `#` | `MVICr 128`, `vr1` | Auto-fixed (codes are normalised everywhere) | Nothing, no flag |
| A code used twice in the sheet | `NH-9` twice | Flagged on the second row | Reason and the edit form on the code |
| No code | Rows without a code | A code is generated when the unit is created | `(auto)` in the code column |
| Type with a typo | `apatment`, `penthous`, `twon house` | Auto-fixed | Nothing |
| Type word the app does not know | `triplex`, `sky loft`, `mazonette` | **Batch** per word: pick a type once | A row per word with its count |
| Type column holds something else | `hyde park` in the type column | Flagged | Reason and the edit form |
| Compound spelled differently from the agency's own | `UPtown` vs `UPtown cairo` | Auto-fixed to the agency's spelling | A note on the row |
| Missing price, area or rooms | An owner's phone and nothing else (about 900 of the 3,720 NCH rows) | Flagged | The edit form opens on exactly the missing fields (sale or rent as a choice) |
| Text only in columns nobody can read | A memo in a column with no header | Skipped, listed | Tab and row with the reason |
| A required column empty on every row | No price column anywhere | The whole upload is refused before anything is saved | The empty columns by name |
| More rows than the limit | Over 5,000 unit rows | Refused with the limit | Message |
| A large workbook | 3.9 MB, 30 tabs | Read in the browser, tab by tab; the server gets only the cells | A progress line per tab |
| Number formats and dates | Delivery dates stored as date numbers | Not handled yet | Shown as numbers, flagged only if they break a rule |
| Status words in a notes column | `rented`, `available`, `moghlk` | Not handled yet: kept in the notes | In the unit's notes |
| Same unit under two codes, or in the sheet and the app with another code | | Not handled yet | Nothing |

## What to add next, in this order

1. Read status words (rented, sold, not available) into the unit status after a one-time confirmation.
2. Treat date numbers and `10/2026`-style delivery cells properly.
3. Warn about a likely duplicate unit (same compound, address, area and price under another code), as the group import already does.
4. Remember a mapping the person chose (column names, type words, rent or sale) per agency, so the next upload from the same agency needs no choices.
