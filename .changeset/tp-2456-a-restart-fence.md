---
"@titan-design/factory": patch
---

`service restart` and `service deploy` (rollback included) on Linux queue `systemctl --user restart --no-block`, wait 45 s for a new MainPID, then fence a main that ignores SIGTERM with `systemctl --user kill --signal=SIGKILL` and log `fenced pid N`; the /health wait starts once the new main exists (TP-2456 a).
