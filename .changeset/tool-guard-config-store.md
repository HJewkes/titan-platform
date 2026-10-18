---
"@titan-design/tool-guard": patch
---

tool-guard guards the fleet config store as permission config (TP-3584). A write by any tool or shell form to the materialized coordinator document (`~/.config/titan-coordinator/` and `~/Library/Preferences/titan-coordinator/`), or to the console's owner state (`lan.token`, `owner-actions/` and `config/` under `~/.local/state/titan-console/`), now classifies as `authority-config`. So do `titan-console login-link` and `token rotate`, under the new spelling `bash.config.console-owner-auth`. They are matched as the console receives them: through any wrapper, with a quoted `"token rotate"` read as its two words, or as the console's CLI script under node or tsx, resolved from the command's directory. The spelling also covers `config import`, which seeds the store's first revision, ahead of the console verb that adds it; `config compare-tree`, which only reads, is left alone. Reads of the same paths, and the console's other verbs, still pass.
