---
"@titan-design/explainer": patch
---

The custom-layer build check now refuses a cue word that does not change the picture (TP-4596). Q-D22 counts every cue of a custom layer as a picture change, so a cue that draws nothing, such as an outline the element's own clip-path cuts away, leaves a still stretch the script never planned, and qa's static-window fails it at render. The check compares the frame just before each cue word with frames five times a second over the second after it, up to the next cue word, on qa's 320x180 grey frame and static level, and a `still-cue` row gets the layer's one rebuild. The builder doctrine now says a cue on an element already shown takes a highlight or pulse at full colour inside its own box. `QaPage` gains `frame(t)`. resolve moves to `p5c2s2f2s2d10`.
