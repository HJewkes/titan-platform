---
"@titan-design/factory": patch
---

Shepherd reads the new head in the round after a wake. `await-new-head` drops the repo's PR snapshot once it sees the new head, so the next `ci-wait` and `sh-observe` no longer read the old head as behind and wake the fixer again. A wake at a head that an earlier wake already saw replaced now waits for a new head and does not spend a repair.
