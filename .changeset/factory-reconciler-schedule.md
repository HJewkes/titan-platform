---
"@titan-design/factory": patch
---

Run the GitHub reconciler on the effective sources mode's cadence: a 15 s due-check tick passes every `github.pollingIntervalMs` under polling and every `github.backstopIntervalMs` under webhook, and a kill-switch flip logs one line and runs a catch-up pass on the next tick. `RECONCILER_KINDS` declares what the reconciler can write, and a test diffs it against the ingress table.
