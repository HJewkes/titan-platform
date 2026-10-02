---
"@titan-design/factory": patch
---

Shepherd no longer merges or opens approve-merge at a head a seat reviewer sent back. When its own reviewer says MERGE, the verdict steps read every roster agent named like a seat reviewer (`-review` or `-review-r<n>`) through the review wiring's reader. If any such reviewer's newest verdict block naming this PR at this head is FIX_FIRST, the step records that FIX_FIRST instead, and the run wakes the fixer. A later MERGE from the same reviewer at the same head clears it, and a FIX_FIRST naming an older head does not block a new one.

The transcript reviewer reader now also returns the `text` input of an assistant `chat_send` tool call, which is where seat reviewers send their verdict. A sent message never counts as the turn's final text, so a transcript that ends on the call still reads as unfinished. The seat check matches the verdict's repo without regard to letter case.

The seat check fails closed. If the roster cannot be read, or a seat reviewer's transcript cannot be read or parsed, the verdict step records `none` with a reason that names the failure, and Shepherd does not merge at that head. A seat reviewer with no finished transcript yet reads as no verdict and does not block.
