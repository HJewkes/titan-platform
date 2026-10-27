---
"@titan-design/factory": minor
---

Shepherd seat digests send deltas. A seat's first digest still lists every open item; after that a digest lists only new open items, one `Cleared:` line of PR refs for items that cleared, and newly finished runs, with unchanged gates folded into one count line naming `titan-factory shepherd waiting` and unchanged seat-fix rounds, which that command does not list, still listed in full. Three or more new gates on one step share one line that still carries each gate's resolve command. Seat memory gains optional per-item PR refs, so an existing `seat-digest.json` still loads.
