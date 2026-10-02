---
"@titan-design/factory": patch
---

Shepherd no longer merges or opens approve-merge at a head a seat reviewer sent back. When its own reviewer says MERGE, the verdict steps read every roster agent named like a seat reviewer (`-review` or `-review-r<n>`) through the review wiring's reader. If any such reviewer's newest verdict block naming this PR at this head is FIX_FIRST, the step records that FIX_FIRST instead, and the run wakes the fixer. A later MERGE from the same reviewer at the same head clears it, and a FIX_FIRST naming an older head does not block a new one.
