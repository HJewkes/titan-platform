---
"@titan-design/factory": patch
---

A stacked PR whose fix-proof was refused on its parent base no longer merges into main on that refusal after GitHub retargets it with the same head (TP-4259). Before deciding a merge into the default branch the refusal names, Shepherd reads the head's fix-proof again (`sh-fix-proof-rebound`) until a run prints a line that is no refusal; until then the allow is a `no-facts` gate. fix-proof.yml also runs on a base edit, so the retarget starts that run, and a skipped judge from any other edit is no longer read as a fix-proof run. A refused or errored proof's own message now appears in the MERGE's recorded fix-proof standing.
