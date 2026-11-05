---
"@titan-design/explainer": minor
---

Run the `explainer.render` stage in process (TP-2992 S3): the template fill draws the storyboard under beat-NN ids,
`compileTimeline` writes `timeline.json`, and `renderVideo` renders the composition page (with the style pack's CSS)
behind the run type's QA gate. The stage stores `mp4`, `vtt`, `render-manifest`, `timeline` and the `page` tree qa
serves; `workers`, `twoRun` and `noQa` are render variant params, `duration-agreement` gates the manifest and
`two-run` is reported. qa now requires the render's `timeline` and its words-and-script fallback is gone. The bridge
runs no stage any more: a host `bridge.json` with a `render` block is refused, naming where `build_sample.py`,
`vite build` and `render.ts` went.
