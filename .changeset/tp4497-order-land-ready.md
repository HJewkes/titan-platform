---
"@titan-design/factory": patch
---

Shepherd's merge order holds a reservation only while its run is at a landable head (TP-4497). A conflicted run releases it before the fixer wake, any wake releases it, and a land round that ends unmerged releases it, so a PR waiting on its implementer's new head no longer holds overlapping ready PRs. Once a later head reaches the merge decision, the run takes the reservation again (`landable again at <sha>`) and overlapping PRs wait behind it. Expiry and `shepherd order clear` are unchanged.
