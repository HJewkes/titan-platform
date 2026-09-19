---
"@titan-design/code-read": minor
---

Add `hierarchy.get`, `node.get`, and `node.resolve` (TP-185); the contract moves from 0.1.0 to 0.1.1, an additive change. The repo, directory, and class levels are synthesized at read time from file paths, qualified symbol names, and spans, because code-graph stores none of them. Directory values roll up by each metric's catalogue rule. A metric whose rule is `none`, such as most git-history counts, returns `null` for a directory with `missing: "no-rollup"` rather than a sum (directory-level history is TP-233). `node.get` adds percentile among same-kind nodes, sibling median and rank, and a delta against an optional baseline. `node.resolve` ports codewatch's search cascade and span containment. `AGENT_COMMANDS` names the commands the design puts on MCP.
