---
"@titan-design/owner-queue": minor
---

Add a strict `start-session` owner op (session name, profile, host, `least-used` or a named account, absolute cwd and brief path, surface, Remote Control, optional brief sha256) and a `sessionKey` helper. `opKeys` keys the op `session:<name>`, which merges, so two deposits starting one session are one item.
