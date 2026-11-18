---
"@titan-design/pm": minor
"@titan-design/active-work": minor
---

Add `IntentLineSchema` to pm: one dated, quoted owner-intent line, refused without a quote or a date. `parseIntentDigest` now validates each bullet with it, and its lines carry `superseded_by` instead of `supersededBy`. pm's plan store gains an `intent` kind under `plan/intent/`. active-work adds `plan intent add|show|list|digest|import-messages`: `add --message <id>` takes the date and `msg:<id>` reference from the owner-message extract, which now lives at `<aw>/factory/plan/owner-messages.jsonl` (the old sources copy is read while it is absent), `digest` renders the lines as a `titan-intent-digest/v1` file, and `active-work lint` refuses a malformed intent line.
