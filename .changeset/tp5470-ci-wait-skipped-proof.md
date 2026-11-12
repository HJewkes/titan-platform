---
"@titan-design/factory": patch
---

ci-wait settles a required fix-proof job when the fix-proof workflow skipped every job at the head, as on the release PR, instead of waiting until it times out. A skip beside a fix-proof job that ran is still judged as before.
