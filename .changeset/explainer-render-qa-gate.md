---
"@titan-design/explainer": minor
---

`renderVideo` takes `qa: { mode: "gate" | "skip", gate }`. In gate mode it runs render-qa's cue-moment gate on the
page before it mixes or captures anything. Held errors write `qa.json` and throw `QaRefused`, and no mix, mp4 or
manifest is left behind. The manifest's `qaGate` is now `absent`, `passed` (with `qa: { heldErrors: 0, gateProfile }`)
or `skipped`. A call with no `qa` option still records `absent`. The qa stage and render share the gate through
`src/qa/cue-gate.ts`.
