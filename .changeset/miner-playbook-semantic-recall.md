---
"@titan-design/session-miner": minor
---

Add `--embedder hash|local|ollama` so `playbook recall` blends vector similarity into its ranking through `MemoryVectors`. When the embedder fails, recall keeps the keyword ranking and reports `memory-vector degraded`.
