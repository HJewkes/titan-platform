---
"@titan-design/review-panel": minor
"@titan-design/factory": patch
---

review-panel: the adversary brief asks for a `Probes:` line above the verdict, and `acceptVerdict` refuses an adversary verdict without one as `probes_missing` (one correction, whose prompt restates the form; the correction cap rises to 1700 characters). `AwaitVerdictInput.shape` names the member awaited. `ShapeBriefInput.holdContext` puts a hold's reason, matched files, done-when and last report into the adversary brief, fenced as data. `ShapeRule.always` plans a shape whatever the files touch.

factory: with `shepherd.gateReset.twoMergeRelease` set to `shadow` or `on`, a run held `g10-adversary:` gets Shepherd's own adversary member beside correctness, whatever `review.panel` says, at `review.adversaryProfile` (default `fable-reviewer`) and under `review.adversaryConfigDir` when set. Its brief carries the hold reason, and a verdict with no `Probes:` line gets one correction turn. Nothing releases on it yet. Absent or `off` changes nothing.
