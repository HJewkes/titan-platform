---
"@titan-design/owner-queue": minor
"@titan-design/factory": minor
---

Add the `host-command` owner op (TP-5265): a deposit may name one vetted owner-only host command by id, starting with `broker-restart-window`, and never a path or argument. The factory's effect starts the vetted script beside the installed agent-chat CLI as a transient `systemd-run --user` unit, outside any agent session's process tree. The op sits under `destructive-local`, which denies owner-remote, until the owner picks its authority row.
