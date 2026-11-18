---
"@titan-design/factory": patch
---

`dispatch shadow-tick` rebuilds lane visibility from the initiative brief and the charter, through pm's `agentAccess`, when every row of the active-work daemon's `inventory` answer lacks `withheld_from_agents` (an older daemon), instead of refusing every lane as owner-only (TP-5868). An unreadable brief or charter withholds; a mixed, empty or failed answer still fails closed. The wake row carries `visibility_read: "rpc" | "file"`.
