---
"@titan-design/autoresearch": minor
---

Add the run read model, replayed from a run's recorded steps. `arRunView(run, looks)` returns the target with its metric projected to the console's names, the settings, the baseline, the best, every round's queue, planner, selection, ladders and ratchet move, the registries and cells replayed over the settled outcomes, the validator looks and the stop reason. Each ladder carries its recorded outcome whole, settled by `finalOutcomes`. `arRunSummary(run)` returns one runs-list row, and `ideaRefs(run, ideaId)` names the base and head an idea's diff spans. `cellTable` and `CellRow` are now exported.
