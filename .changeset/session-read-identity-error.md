---
"@titan-design/session-read": minor
---

session-read: export `SessionIdentityError`, a `TypeError` subclass with a stable `code` field (`"foreign_native_session"` or `"multiple_parent_sessions"`), thrown instead of a bare `TypeError` when a Claude transcript record belongs to a different native session or a sidechain window names multiple parent sessions. Both message texts are unchanged; consumers matching them by prefix keep working, and can now switch to `instanceof SessionIdentityError` plus `.code` (TP-422).
