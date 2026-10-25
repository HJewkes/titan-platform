---
"@titan-design/factory": minor
---

Shepherd seat digests send deltas. A seat's first digest still lists every open item; after that a digest lists only new open items, one `Cleared:` line of PR refs for items that cleared, and newly finished runs, with the unchanged open items folded into one count line naming `titan-factory shepherd waiting`. Three or more new gates on one step share one line that still carries each gate's resolve command. Seat memory gains optional per-item PR refs, so an existing `seat-digest.json` still loads.
