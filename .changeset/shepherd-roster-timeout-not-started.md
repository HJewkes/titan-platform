---
"@titan-design/factory": patch
---

Count no review round when a reviewer's session-start wait only times out: after an ask that went through, if every roster read timed out and none answered, sh-review now answers not-started (retry-review) instead of "did not start one session in time".
