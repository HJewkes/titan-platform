---
"@titan-design/factory": patch
---

Add `--verify <ref>` and `--pin-from <ref>` to `titan-factory shepherd plan-round` (TP-4360 slice 3). `--verify` prints no round and exits 1 when the ref changes a path the plan does not list (rename sources included), a ci-policy plan's pinned blob differs at the ref, or a file pinned absent exists there; each `drift:` line ends with the re-ask command. `--pin-from` is the re-ask: it pins each planned file to its blob at the ref (`null` where the ref lacks it) and refuses a block that still gives content inline. Both stay local and read-only.
