---
"@titan-design/explainer": patch
---

The run that `explainer edit apply --start` launches now starts as a transient systemd user unit (`explainer-run-<editId>`) when a user manager is reachable, so a restart of the calling service no longer kills it. Without one, or if `systemd-run` refuses, it is the detached child as before.
