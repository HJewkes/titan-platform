---
"@titan-design/titan": minor
---

Add `titan health install [--dry-run]` and `titan health uninstall`. Install renders the `titan-health-sample` oneshot service (Nice 10, idle IO, CPU and IO accounting) and its minutely timer (`AccuracySec=1s`, not persistent) into the systemd user directory, with `ExecStart` calling node and the titan bin by absolute path, then runs `daemon-reload` and `enable --now` on the timer. Uninstall disables the timer, removes both units and reloads. Both exit 2 on any platform but Linux.
