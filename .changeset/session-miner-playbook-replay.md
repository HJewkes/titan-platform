---
"@titan-design/session-miner": patch
---

Add `replayPlaybook`, which seeds a playbook bullet from the first occurrence of each recurring Drain cluster and scores how often recall on a later session's opening query would have served it in the top k, next to a baseline repeat rate.
