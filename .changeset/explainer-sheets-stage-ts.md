---
"@titan-design/explainer": minor
---

The `sheets` stage runs in TypeScript. From the rendered MP4 and the script it writes the theater sidecar (`titan-console/video-meta@1`, v1 fields plus an `explainer` block with the video id, every run of the video, the profile, the script sha and the fingerprint), a 480 px poster 30 % in, and a `fingerprint` artifact whose per-beat layout key is `component/slots/anchors`. The video's run ids are part of the stage key. `explainer stage sheets --video <id>` lists that video's runs. A host `bridge.json` that still has a `sheets` block is refused, and the block must be deleted. A run pinned mid-pipeline must now pin `script` as well, because sheets reads it.
