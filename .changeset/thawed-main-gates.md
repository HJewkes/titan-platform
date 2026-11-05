---
"@titan-design/factory": patch
---

A `main-red-again` or `main-frozen` gate on a merged PR no longer stays open after its freeze episode thaws. The gone sweep (every 5 minutes and on each thaw) and `shepherd resync` cancel the gate once the episode it asked about is no longer live. Each cancel writes a `gate-cancel` shepherd_event row naming the run, which takes a table-rebuild migration (39). The run reads the cancel as its answer and goes on to cleanup without thawing anything. A gate cancelled for any other reason still fails the run, as before. `resync` reports these cancels as `closedMainGates`.
