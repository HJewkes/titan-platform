---
"@titan-design/factory": patch
---

The CI-policy classifier now compares the owner and repo of a PR body's measurement run link case-insensitively, as GitHub does. A budget-only change whose body linked a run as `HJewkes/...` while Shepherd carried `hjewkes/...` no longer reads as "links no measurement run".
