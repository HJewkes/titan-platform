---
"@titan-design/active-work": minor
---

Add `active-work miner rebuild` (TP-882). It indexes the corpus into a fresh `graph.sqlite3.next` without the refresh lock, carrying over the `transcript` rows with their ids (rewound, so every file is re-read), `preserved_row`, the `pr` rows with their forge columns and the GitHub review verdicts. Then, under the lock, it catches both files up and compares their totals: row counts of every table a preserved session replays into, plus turn and token sums. If they match, it keeps the old file as a hard-linked `graph.sqlite3.bak-pre-rebuild-<time>` and renames the new file over the path, so the path never goes missing. A `graph.sqlite3.swapped` marker records the new inode. A totals mismatch leaves `.next` in place; `--force` swaps anyway and `--resume` continues an existing `.next`. `miner refresh --full` is unchanged.

The daemon now compares the inode at the graph path with its open handle inside the lock before each pass, and reopens the graph and its checkpoint worker when they differ.
