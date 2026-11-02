---
"@titan-design/explainer": patch
---

Render keeps a beat's cue reveals when it fills from the `generated-slots` pin. A pinned beat whose derivation names a fallback (a button with no action draws as outro) now renders as that same kind, the one resolve drew, instead of dropping to the default list. Each cued bar of a bar chart grows on its own cue, and an uncued bar waits for the cue above it. A stat's count-up stops at its figure instead of showing the spring's overshoot. Text entrances (`enter` and `fadeUp`) rise and uncover at full colour instead of fading through colours under the contrast floor. A beat whose voice runs short now ends one second after its tail. It never goes under the 6 s beat floor or over its plan, and a held beat keeps its plan. The stage-fit scan no longer seeks backwards when a beat ends just past a half second. The tts stage is now `p6d` and render is `m10c10`.
