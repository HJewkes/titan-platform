---
"@titan-design/explainer": minor
---

Add the emphasis mapping contract and the emphasis-target gate (TP-4016). `emphasisCues` and `targetsForSpan` map a span of a beat's script, as a word range or a time range, to the `cue.target` element ids it covers. `emphasisTargetGate` fails any emphasis cue that resolves to no element of its beat, to more than one, or to an element laid out off the frame. Given the mark frames either side of a step, it also fails a step that leaves its target unchanged on screen. Script beats gain an optional `visual.beat` beat-spec ref, which the gate resolves targets against. How the element is emphasised stays with the beat template; the gate checks only the mapping.
