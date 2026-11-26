---
"@titan-design/explainer": minor
---

Add the camera-path check to L0 (TP-5887). `cameraPathFromMap` samples a compiled map track into a camera track with its key boxes and reveal windows, and `cameraPathRows` reports `camera:velocity`, `camera:jerk`, `camera:key-in-frame` and `camera:seen-before-reveal` through the existing camera rows. Thresholds, severities, the sample multiple and the assumed smootherstep easing live in `doctrine/qa/camera-path.yaml`. Every row is a warning, and `runL0` takes the camera input as an optional sixth argument; without it the rows stay dormant.
