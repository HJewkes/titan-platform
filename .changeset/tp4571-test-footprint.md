---
---

Add `scripts/test-footprint.mjs`, a per-file measure of what a vitest run costs the machine: CPU with children, processes spawned, temp files created and left, peak fds and memory. Repo tooling only; no package changes.
