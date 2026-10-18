---
"@titan-design/tool-guard": patch
---

tool-guard guards the fleet config store as permission config (TP-3584). A write by any tool or shell form to the materialized coordinator document (`~/.config/titan-coordinator/` and `~/Library/Preferences/titan-coordinator/`), or to the console's owner state (`lan.token`, `owner-actions/` and `config/` under `~/.local/state/titan-console/`), now classifies as `authority-config`. So does `titan-console login-link`, `token rotate` or `config import`, typed through any wrapper or run as the console's CLI script under node or tsx, with the new spelling `bash.config.console-owner-auth`. Reads of the same paths, and the console's other verbs (`config compare-tree` among them), still pass.
