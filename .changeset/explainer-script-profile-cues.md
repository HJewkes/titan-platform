---
"@titan-design/explainer": minor
---

The script stage plans a script under the spine's structure (design-journey only when the spine names none) and stamps the run's profile on it; `parseScript` now rejects an unknown profile. The prompt lists each chapter's lead beat spec with its emphasis targets, and asks for `visual.beat` and a cue per target. Two new script-stage gates: `cues-present` fails a beat whose beat spec has emphasis targets and no cue, or a chapter whose lead beat is on none of its beats; `unknown-words` fails a spoken word the voice's g2p, the doctrine lexicon included, has no phonemes for. `cue-resolution` at tts fails a script of no cues when a beat names a spec with targets. Q-E20 now reads the gathered facts at every L0 call site (the script, rewrite and eval stages, and `explainer eval l0 --facts`), and its repair hint names the nearest fact.
