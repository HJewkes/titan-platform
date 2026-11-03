---
"@titan-design/factory": patch
---

On Linux, `service install` (including `--dry-run`), `service uninstall` and `service status` no longer fold a failed `systemctl --user show` (no user bus, permission, timeout) into "not loaded". Install and uninstall refuse with systemctl's stderr (or `exit N`) and the user-bus remedy, run no mutating systemctl call and touch no file; status prints `<unit>: unreadable: ...`. A unit that is missing still reads as exit 0 with `LoadState=not-found` and stays "not loaded".
