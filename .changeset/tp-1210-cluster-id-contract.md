---
"@titan-design/cluster": patch
---

State the template-id contract as it is: ids are deterministic for a given input order and stable across restarts through snapshot and restore, and lines that Drain merges share the id of whichever line founded the cluster. No change to how ids are computed.
