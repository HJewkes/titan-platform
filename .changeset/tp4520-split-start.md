---
"@titan-design/explainer": patch
---

The script stage now splits a cue-less claim-card whose one stretch runs past `pacing.pictureChangeFailS` on its sentence boundaries, at $0, and uses the split only as the repair's starting script. It does so when the split clears Q-D17 at no more failing rows than the seed. Every spoken word is kept in order, each piece keeps the beat floor, heldS stays on the last piece, and the first piece keeps the beat's id. The repair's failure list then names the job (a spoken link at each boundary, and a claim and chip per piece). The repaired script is kept only when it fails strictly fewer rows than the seed. A repair that leaves rows failing stores each candidate it tried (`candidate-split`, `candidate-repair-N`) and notes the failure list each round sent. Script stage version x23.
