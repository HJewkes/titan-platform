---
"@titan-design/session-read": patch
---

Remove the unused `modelForActiveTurn` method from the Codex decoder and narrow its private `metadata` scope parameter to `"conversation" | "turn"`, the only two values it is ever called with.
