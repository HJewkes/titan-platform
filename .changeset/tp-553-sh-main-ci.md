---
"@titan-design/factory": patch
---

Shepherd reads main CI on the merge sha after land returns merged, records green, red or none, and opens the owner gate main-red on red or none. A non-empty `after` stage list runs nothing and opens the owner gate after-stages.
