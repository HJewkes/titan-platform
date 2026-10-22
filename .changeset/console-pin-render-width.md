---
"titan-console": patch
---

A design round's pin draws only on the render of the width it was placed at, so a pin placed on a variant's 390 px
render no longer shows at the same percentages, in the wrong place, on its 1440 px render or its captured PNG
(TP-3964). Sent pins now read back their width; a pin with no width still draws on every render.
