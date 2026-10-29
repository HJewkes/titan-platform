---
"@titan-design/factory": patch
---

Merge order: a reservation whose run a person holds (an owner hold, or a g10 or other gating hold no reviewer has satisfied) no longer orders unheld peers while the hold lasts, so it stops blocking them until its TTL. The merge guard, the order wait and `shepherd order` all read the same predicate, and `shepherd order` lists such a reservation as `held`. A merge step that starts waiting behind a reservation now logs one `order-wait` event, which `shepherd timeline` shows, and a merge past its phase limit names the wait in its `shepherd status` stall flag (TP-4133).
