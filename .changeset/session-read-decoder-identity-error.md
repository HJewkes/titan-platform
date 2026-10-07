---
"@titan-design/session-read": minor
---

The Codex and Claude decoders and the recent Codex reader now throw `SessionIdentityError` (still a `TypeError` subclass) when a file's records belong to a different native session, so a consumer can quarantine such a file while letting real programming errors propagate.
