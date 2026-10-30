---
"@titan-design/explainer": patch
---

The custom-layer build check now also reads qa's held kinds over a 10 Hz sweep of the beat, so a pulse caught at its peak on two of qa's samples is refused before render (TP-4617). An absolute tint over a panel's text and chip had passed the check and was then held by qa as occluded and box-overlap. qa's samples land wherever the real voice puts the cue words, so a cue moment and a sweep tick can fall a tenth of a second apart. A replay corpus of synthetic layers, one per pattern qa has refused, now requires the check to flag the kinds qa held. The custom-layer doctrine forbids absolute overlays over text or chips: pulse with a border, an inset box-shadow or the element's own background. Resolve moves to `p5c2s2f2s2d14`.
