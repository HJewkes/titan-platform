---
"@titan-design/explainer": patch
---

The register rewrite no longer directs the collapse of a list of three that holds more than one cue word: the guard refuses any line that stops speaking a cue, so that directive could only buy a `cue-lost` refusal. A list with a single cued item still collapses, and its directive now names the cue word as the item to keep in the line. A number range such as "thirty to thirty-five percent" is listed as one number in the numbers directive, and a new `range-split` guard rule refuses a rewrite that keeps one end of a range and drops the other. The rewrite stage is re-keyed through `stage-bumps/TP-3881.json`.
