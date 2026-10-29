---
"@titan-design/factory": patch
---

Shepherd's merge order holds a reservation only through a conflict round or at a landable head (TP-4497). A conflict wake keeps it, so nothing overlapping lands while the fixer merges main (TP-4098). It is released before any other wake (review FIX_FIRST, fix-proof, CI fix), once no fixer works on the conflict (an unhandled or exited wake, the owner gate, a demoted wait for a new head), and when a land round ends unmerged. Once a later head reaches the merge decision, the run takes the reservation again (`landable again at <sha>`) and overlapping PRs wait behind it. Expiry and `shepherd order clear` are unchanged.
