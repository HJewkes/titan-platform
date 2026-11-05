---
"@titan-design/factory": patch
---

Factory removes the post-merge chore files of a run that ended (completed, failed or cancelled) without recording its post-merge step. The sweep runs on each workflow final event and when the host binds, and only once the chore has finished or is lost. A chore still running, an active run (a parked `recovery_required` one included), a run missing from the store, an unreadable marker and a launch less than 60 s old are kept.
