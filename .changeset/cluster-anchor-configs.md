---
"@titan-design/cluster": minor
---

Make signature anchor rules frozen data keyed by partition. `AnchorConfigs` and `DEFAULT_ANCHOR_CONFIGS` are exported; `ClustererOptions.anchors` and an optional third argument to `extractSignature` and `hasErrorSignal` let a consumer map its own partitions (for example `Bash`) onto the `test` or `git` rules. The defaults keep today's behavior for `test`, `git` and every other partition.
