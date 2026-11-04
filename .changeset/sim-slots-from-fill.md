---
"@titan-design/explainer": minor
---

Resolve now sweeps each sim beat on the slots the template fill draws for it: the `slots` pin's entry, or the generated layer when there is no pin, with the owner's `visual.slots` on top. The sim beats are filled on their own before the cut, because the fill over the whole script needs the cut list. A sim beat with no sim slots to sweep is now cut with `E-SIM-NO-SLOTS`. Before this change it was left uncut and only noted as "not swept or checked". The reason the fill gave is recorded in `sim-traces` and the stage notes. `runSimPass` now takes `filled` (each beat's filled slots, or a problem) in place of `slots`, and `SimPass` drops `unslotted`. `explainer edit check` fills only the beats the base run's resolve kept, so an edit on a base with a cut sim beat is no longer refused. The resolve stage version changes.
