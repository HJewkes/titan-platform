---
"@titan-design/factory": patch
---

Bound single-reviewer not-started retries in the run itself (TP-5386). From the `MAX_NOT_STARTED_REVIEWS`th review dispatch at one head that starts no reviewer, the run takes the existing `no-reviewer` hold and alerts the seat instead of retrying again; before, only the status view read the streak as stalled. A replayed record that went on without the hold keeps its recorded retry, and a not-started review intent (a slow roster) is unchanged.
