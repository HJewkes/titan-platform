---
"@titan-design/explainer": patch
---

Excuse a settled frame under speech in qa's static-window and the script's Q-D22. A still run after a beat's last reveal, with every element it draws already shown, may run up to `SETTLED_SPEECH_MAX_S` (6 s) while the narration speaks over it; the part of the run the voice is silent over still keeps to `pacing.staticMaxS`, a frame still waiting on an element still fails at 3 s, and a custom layer never settles. Both gates share the constant and the rule from `settled-speech.ts`, and Q-D22's doctrine and repair hints name the 6 s allowance. The script stage version moves to x35, rewrite to x17, eval to x18 (their cached L0 rows read Q-D22) and qa to x11e.
