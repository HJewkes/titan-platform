---
"@titan-design/active-work": minor
---

`note add` now stamps every new note with `created_at` (a full ISO timestamp; `created` stays a date), takes an optional `--session`, and records `agent` from `AGENT_CHAT_NAME` when run from the CLI. Notes filed before this change still load.
