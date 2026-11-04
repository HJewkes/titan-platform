---
"titan-console": patch
"@titan-design/autoresearch": patch
---

The console's `#/autoresearch` run page reads and shows C-256 S5's read model. Each round lists its ratchet moves and the later winners measured again on the new head, with decision, reason and Δ. A new Snapshots section lists the snapshot PRs, any cut waiting behind the open one, and each sync with its state, conflicts, frozen paths, a failed sync's reason, gate and B's re-measure. The runs list names the open snapshot, and the idea record names a re-evaluation. `reeval:<reason>` reject codes now read as text. A factory from before S5 still parses, with every new section empty. A sync's re-measure never reaches a ladder, and no `sync` rung is admitted. In `@titan-design/autoresearch`, the console schema copies used by tests now carry these fields, which replace the proposed copies.
