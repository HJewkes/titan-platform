---
"@titan-design/session-read": minor
---

The `review_verdict` event carries `ordinal`, the verdict's index among those parsed from its tool use's message, so a consumer can key verdicts stably across chunk boundaries.
