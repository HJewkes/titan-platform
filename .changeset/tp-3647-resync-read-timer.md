---
"@titan-design/factory": patch
---

Resync PR-read deadlines now arm through an optional `readTimer` on `ShepherdServices`, defaulting to the wall clock. A test can pass a deadline in by hand instead of faking global timers, which also captured the seed host's gate polls and made the hung-read test time out on a loaded runner (TP-3647).
