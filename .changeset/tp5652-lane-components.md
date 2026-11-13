---
"@titan-design/factory": patch
---

`dispatch eligible` holds a lane on a deploy stall or red main only when the lane depends on the failing component: the factory deploy, or main CI of a named repo. A checked-in table maps each lane (initiative plus tag) to its components; a lane without an entry still depends on everything, and a named component whose health cannot be read counts as stalled.
