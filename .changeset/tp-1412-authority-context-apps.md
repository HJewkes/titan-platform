---
"@titan-design/authority": patch
---

`MergeFacts` gains an optional `contextApps` map: a run of a listed context counts toward `required-contexts-green` and `no-non-green-run` only from the apps listed for it, and every other context still uses `allowedApps`. A fact record without the field evaluates as before; a malformed map fails both conditions.
