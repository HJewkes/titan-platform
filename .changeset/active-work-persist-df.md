---
"@titan-design/active-work": patch
---

Persist loop retrieval's document-frequency counts in a sidecar beside the session graph, so a warm `open` skips the FTS5 vocabulary lookups an earlier process already paid for. A pass that indexes spans deletes the sidecar, the counts are stamped with the graph's inode and highest span ids, and a missing or unreadable sidecar falls back to live counts.
