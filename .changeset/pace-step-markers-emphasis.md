---
"@titan-design/explainer": patch
---

The pace item track no longer throws `unknown cue kind` on two kinds of cue. A `step-markers` cue now counts as an attribute: it marks recipe steps already on screen. On a beat that names a beat spec (`visual.beat`), each cue target is an emphasis element id rather than `kind:label`, and those cues also count as attributes. The script-stage pace gate now reaches a verdict on drafts that carry either.
