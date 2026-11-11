---
"@titan-design/active-work": minor
---

Every array flag takes `@<file>`: the file's non-blank lines, trimmed, each counted as one more use of the flag (TP-5228). An empty or unreadable file is a usage error that names it, and a comma in a line is refused as it is on the command line. The expansion moved from `miner cost --session-ids` into the CLI layer, so `miner.cost` called over RPC now takes `@...` values literally.
