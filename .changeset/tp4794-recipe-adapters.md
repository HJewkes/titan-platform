---
"@titan-design/factory": patch
---

TP-4794: publish-review, visual-accept and visual-packet-trigger no longer build their GitHub client or env/fs wiring; each moves to a sibling `*-adapter.ts` that callers pass in. No step id, order or recorded input changes.
