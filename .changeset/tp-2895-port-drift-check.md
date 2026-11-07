---
"@titan-design/factory": patch
---

The burndown port map pins every ported file and leaf port to a 40-hex `portedFrom` (28c31ed for the TP-2627 ports), and `scripts/burndown-port-map.mjs check` prints a `drifted:` line for any entry whose agent-chat source gained commits after it, exiting 2 on drift alone and 1 for unmapped, removed or unpinned entries. Tooling only; no runtime change.
