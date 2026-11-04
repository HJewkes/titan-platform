---
"@titan-design/explainer": minor
---

Owner slot edits: `SlotEditSchema` (`explainer.slot-edit/v1`) and `applyEdit`, which refuses a stale base, an unknown or custom-layer beat and a slot change that drops an element a cue targets, and returns the new script and a field diff. `explainer edit check` prints the verdict and writes nothing; `explainer edit apply [--start]` stores the script and an edit ledger row under `<data dir>/edits/` and launches the linked run from resolve with the script and the base's custom layers pinned under a $0.25 backstop; `explainer edit list` lists a render's or a video's edits with their run status. `explainer run --edit <editId>` links the run into the ledger, and its report names the edit.
