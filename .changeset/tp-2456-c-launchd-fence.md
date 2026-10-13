---
"@titan-design/factory": patch
---

On macOS, `service restart` and `service deploy` (rollback included) wait 45 s for a new launchd pid after `launchctl kickstart -k`, then SIGKILL the job through `launchctl kill SIGKILL` and log `fenced pid N`, as the systemd path already does. The rendered systemd unit sets `TimeoutStopSec=60`; run `titan-factory service install` once to rewrite an installed unit (TP-2456 c).
