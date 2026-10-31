---
"@titan-design/authority": minor
"@titan-design/factory": patch
---

Add the `pr-close`, `deploy-resume` and `fleet-config` action classes, with rows PRC-*, DPR-* and FLC-*. The owner at a terminal is allowed each; owner-remote gets a gate only owner-remote resolves, after a read-back of the target; every agent class is denied. `fleet-config` covers restart-class keys too.

The factory's owner ops `close-pr`, `deploy-pause-clear` and `factory-config-set` now evaluate against these rows instead of the deny-only stand-ins (`destructive-remote`, `release`, `authority-config`). Their effects are already in place, so `close-pr` and `deploy-pause-clear` become runnable from the console tap once the owner confirms the read-back, as owner decision 528 approved. `factory-config-set` has no effect yet and is still refused.
