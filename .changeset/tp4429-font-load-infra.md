---
"@titan-design/frame-capture": patch
"@titan-design/explainer": patch
---

An unloaded font now fails `openCapturePage` with a `FontLoadError` that names each face and the font URLs the browser could not fetch. Resolve's build-time text check treats any throw from the check as an infrastructure fault, not a layer defect: the layer is not rebuilt, the reason reads "layer check could not run, not a layer defect", and a failed resolve stores the sources of every layer it built under `custom-layers-unbuilt` in the failed record. A new $0 font check on built layer sources (`@font-face`, font imports, `url()` to font files, remote font hosts, a `fontFamily` outside the `--font-family-*` tokens) rebuilds a layer once, naming the line and the theme tokens; the builder doctrine gains the same rule, which changes the builder's base prompt sha and so its build-cache keys.
