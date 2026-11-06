---
"@titan-design/active-work": patch
---

The checkpoint worker reports each checkpoint's start and end through an optional `onCheckpoint` callback, so the "off the event loop" test counts loop turns during a slow checkpoint instead of timing the pass against a wall-clock bound. Test seam only; daemon behavior is unchanged.
