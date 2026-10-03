---
"@titan-design/decider": minor
---

Add `noteSource`, the decision-notes ledger source ported from active-work's `src/precedent/notes.ts`. It keeps v1's `note:<slug>/<file>` keys, writes `outcome: "none"` rows, and holds one watermark per note file so re-running extraction parses only changed notes.
