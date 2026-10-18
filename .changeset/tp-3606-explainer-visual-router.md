---
"@titan-design/explainer": minor
---

Consume titan-design's visual router (TP-3606, TP-3597 S1c). `doctrine/visual-router.json` pins the router's patterns, type catalogue and per-type routing; `loadVisualRouter` parses it strictly. `sliceForStage` gives the plan stage the routing table in `routing`. A storyboard beat's new optional `kind` names a router type, and `buildPacket` adds that type's card as `visual`: its gap warning, the closest built type and its not-this list. The new `visual:gap-kind` L0 lint warns on a script beat whose `kind` is a gap type.
