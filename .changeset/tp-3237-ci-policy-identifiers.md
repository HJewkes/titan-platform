---
"@titan-design/session-read": patch
"@titan-design/factory": patch
---

The verdict parser no longer reads a line naming a ci-policy identifier (`ci-policy-changes.ts`, `ciPolicyAt`) as a CI-policy line, so such a review parses MERGE; a weakened reading still fails closed wherever it sits. Shepherd's correction now quotes the blamed line, and the failed-round list and ops notice name a correction that did not parse `malformed`, not `timeout` (TP-3237).
