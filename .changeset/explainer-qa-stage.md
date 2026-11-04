---
"@titan-design/explainer": minor
---

Run the qa stage in process: render-qa's cue-moment gate behind a `QaEngine` seam, the per-type gate profile in
`doctrine/qa/gate-profile.yaml`, `qa.json` as `explainer.qa/v1`, and the `held-errors` and `mp4-duration` gates.
The bridge retires `qa`: a host `bridge.json` that still has a `qa` block is refused.
Late-fill skips lead-line beats (`qaLeadLine` in `visual` or the template fill's hints), as the spike's qa did.
