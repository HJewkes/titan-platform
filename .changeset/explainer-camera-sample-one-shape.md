---
"@titan-design/explainer": patch
---

Share one `CameraSample` (`{ t, box }`) between the camera motion and framing rows, and export `keyBoxRows` and `revealRows`. Framing callers that passed `{ t, camera }` samples now pass `{ t, box }`; the rows are unchanged.
