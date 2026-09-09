---
"@titan-design/session-miner": minor
---

Wire `@titan-design/memory` in as a `playbook` command family (add, recall, reflect,
status) on the existing registry, so it lands on the CLI, MCP, and HTTP at once. Provenance
comes from the miner's own session refs and byte offsets, and `playbook reflect` builds a
session diary deterministically from the subgraph with outcome labels derived from merged
pull requests, task status, and clustered error signatures. The playbook stays strictly
downstream of the index.
