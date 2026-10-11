---
"@titan-design/tool-guard": minor
---

Honour `TITAN_TOOL_GUARD_BYPASS=1` only for a session the owner started at a terminal: the hook reads its ancestors from `ps`, and the bypass counts only when exactly one is `claude` and that one has a controlling terminal. A `claude` that any command of an agent starts, however the variable was spelled, keeps agent authority, and so does one detached with `setsid` or `systemd-run`. One started inside a detached pseudo-terminal (`tmux new -d`) is not caught. Breaking: `observeActor` takes a third argument, the ancestry reader (`readAncestry`, now exported), and `HookPort` and `CliIo` need an `ancestry` member.
