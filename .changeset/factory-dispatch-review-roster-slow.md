---
"@titan-design/factory": patch
---

Shepherd's sh-review step now waits out a slow first roster read the same way sh-review-intent does, and answers a roster still unread after the session-start window as not started, so a busy broker retries the review instead of holding the run as no-reviewer.
