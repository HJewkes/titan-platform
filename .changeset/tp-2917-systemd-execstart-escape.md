---
"@titan-design/active-work": patch
---

The systemd unit's ExecStart now escapes each argument with the daemon `./service` escaper, so a node or CLI path containing a `%` or `$` no longer expands as a unit specifier or variable.
