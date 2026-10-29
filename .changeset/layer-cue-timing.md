---
"@titan-design/explainer": patch
---

Custom layers time their cues from the spoken words (TP-4469). The builder doctrine requires `useCue(<cue word>)` for every cue target and no literal cue seconds. Resolve's $0 layer build check now refuses three more things, each with one rebuild and a hint naming the cue or the text: a cue word the layer never reads through `useCue`, a number or headline name on the settled frame that the narration never says (qa's narration-facts rule), and a text that shares 5 or more words in a row with the narration (qa's G10). The resolve stage version moves to p5c2s2f2s2d5.
