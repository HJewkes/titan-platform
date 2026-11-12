---
"@titan-design/active-work": patch
---

The rendered systemd unit now doubles `%` in the `StandardOutput=` and `StandardError=` `append:` log paths, as it already does for `ExecStart` and `Environment`, so a home directory containing `%` is no longer read as a unit specifier.
