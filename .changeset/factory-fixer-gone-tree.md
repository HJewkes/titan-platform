---
"@titan-design/factory": patch
---

Shepherd's main-red fixer sweep now treats an `agent park` refusal saying the worktree "is not on disk" as already parked: it retires the fixer, so the next sweep skips it instead of logging "left an ended main-red fixer" every ten minutes. Any other refusal still leaves the fixer and retries.
