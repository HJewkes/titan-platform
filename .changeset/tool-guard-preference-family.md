---
"@titan-design/tool-guard": minor
---

Add the preference family: `checkPreferences(commands, ctx)` checks commands parsed by `extractCommands` against seven rows (R86 kill by name, R50 local publish, R31 a merge or release chained to other commands, R127 CI polling, R133 a raw merge in a seat session, R64 `XDG_DATA_HOME` before `active-work`, R164 skipped git hooks) and returns `{ id, message }[]`, each message one sentence saying what to do instead. Pure: no filesystem, environment or clock.
