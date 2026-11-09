---
"@titan-design/matrix-bus": patch
---

`bootstrapQueueRoom` now invites any mirror user that is neither joined nor invited when the queue alias already resolves, so a mirror that was never invited no longer gets a 403 on join.
