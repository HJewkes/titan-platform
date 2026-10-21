---
"titan-console": minor
---

Keep an unsent question or design round's answers across a reload (TP-3778). Picks, text, comments, option notes, frame verdicts, comments and pins, and the round feedback are written to localStorage under the round's id a moment after each change, bound to the round's manifest sha. A reload of the same round and sha restores them; a different sha drops the draft and says "Draft from an older version discarded". A successful send clears it, a sent or withdrawn round never restores one, and a corrupt or schema-failing draft is ignored.
