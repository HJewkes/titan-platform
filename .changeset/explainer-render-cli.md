---
"@titan-design/explainer": minor
---

Adds `explainer render <beats.json> --out <dir> [--audio <dir>] [--workers <n>] [--no-qa]` (TP-2992 S2): compiles the storyboard into `timeline.json`, builds the composition page once per page-source sha into a cache dir, serves it on loopback and renders `<stem>.mp4`, `captions.vtt` and `render-manifest.json`. Without `--audio` the render is a DRAFT; `--no-qa` records `qaGate: "skipped"`. Adds the root `pnpm explainer` script. `RenderTimeline.provisional` is now optional, matching the page's timeline schema.
