---
"@titan-design/factory": patch
---

A `shepherd-merge-guard/ci-policy-weakened` (D21) approve-merge gate now asks the owner again at every head: an earlier approval never answers it, and an approval given at it follows to no later gate. Its brief no longer recommends merge on the reviewer's MERGE; it reads "The reviewer judged CI policy weakened; read the card and the diff; no recommendation."
