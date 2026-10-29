---
"@titan-design/explainer": minor
---

Custom layers are built by claude-print by default. When a host sets no `beatWorker` and a `claude` binary is on the host, the resolve stage builds each custom beat with one sonnet `claude -p` call. The call uses `doctrine/builders/custom-layer.md` as the system prompt. Spend is priced from tokens, not from `total_cost_usd`. Every build must pass an esbuild compile gate with an import allowlist; a build that fails is marked `needsRepair` with the error. A build that passes is cached by packet key across runs, so a script or facts edit does not rebuild a beat whose packet is unchanged. `beatWorker: null` turns building off. With no worker, custom beats are still left unbuilt with a note.
