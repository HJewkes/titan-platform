---
"@titan-design/factory": patch
---

Add `titan-factory shepherd visual-delta --repo R --pr N [--head SHA]` (TP-4320 S6), a read-only calibration read. It measures the PR's visual delta under the repo's `shepherd.visualThreshold` in any mode, as the merge evidence step would, and prints JSON: the stored `visualDelta` record plus `unsupportedFormat`, the count of shots the bounded decoder refused as `unsupported PNG format`. It runs no step, posts no comment and stores no record. It is declared a read, so with no serve answering it runs in-process, in an agent shell too, and it is also the `shepherd__visual-delta` MCP tool. A repo with no key exits 66. Config defaults are unchanged.
