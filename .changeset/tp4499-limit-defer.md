---
"@titan-design/factory": patch
---

A build-surface spawn refused at the account limit no longer fails the step: the implementer runner waits until the reset the refusal names (`resets 15:30 UTC`) and asks again, and falls back to the load-deferral backoff when it names none.
