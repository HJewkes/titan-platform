---
"@titan-design/frame-capture": patch
"@titan-design/explainer": patch
---

An unloaded font now fails `openCapturePage` with a `FontLoadError` that names each face and the font URLs the browser could not fetch. Resolve's build-time text check treats any throw from the check as an infrastructure fault, not a layer defect: the layer is not rebuilt, the reason reads "layer check could not run, not a layer defect", and a failed resolve stores the sources of every layer it built under `custom-layers-unbuilt` in the failed record. The layer build output is unchanged, so no builder version moves.
