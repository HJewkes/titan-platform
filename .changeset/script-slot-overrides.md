---
"@titan-design/explainer": minor
---

script/v1 beats take optional owner overrides: `visual.slots` (top-level slot fields that replace the generated values whole and win over every other slot layer) and `visual.tune` (tuning constants, carried untouched for now). The resolve stage's new `slot-overrides` gate refuses an override field the chosen beat spec's slot schema lacks or rejects, naming its path, and any override on a custom-layer beat. The emphasis-target gate reads slots with the overrides applied. A script with neither field resolves to the same bytes as before. The script stage never shows the drafting model either field, and a draft reply naming them loses them as `script-unknown-keys`. The resolve stage version moves to `p5c2`.
