---
"@titan-design/factory": minor
---

Add `titan-factory gate resolve-batch`. It takes an itemized list of merge gates (gate, PR, head sha) from `--file` or `--json`, prints the list, and asks for owner presence once. Each gate then resolves through the `gate resolve` path, but only while it is still pending at the listed head; an item that moved or closed is skipped and named. Release and hardware gates are refused from a batch. The signed batch and each item's outcome are recorded in the new `gate_batch` and `gate_batch_item` tables (migration 15).
