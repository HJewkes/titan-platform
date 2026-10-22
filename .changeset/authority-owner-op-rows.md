---
"@titan-design/authority": minor
"@titan-design/factory": patch
---

Add the `pr-close`, `deploy-resume` and `fleet-config` action classes, with rows PRC-*, DPR-* and FLC-*. The owner at a terminal is allowed each; owner-remote gets a gate only owner-remote resolves, after a read-back of the target; every agent class is denied. `fleet-config` covers restart-class keys too.

The factory's owner ops `close-pr`, `deploy-pause-clear` and `factory-config-set` now evaluate against these rows instead of the deny-only stand-ins (`destructive-remote`, `release`, `authority-config`). An op still runs only once its effect lands.
