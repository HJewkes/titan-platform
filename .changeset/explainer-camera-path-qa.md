---
"@titan-design/explainer": minor
---

Add camera-path QA (TP-5887): four L0 warning rows read off a resolved camera track with no render. `camera:velocity` and `camera:jerk` hold peak screen-relative speed and jerk to limits, `camera:key-in-frame` flags a focused box that leaves the frame or dips into the caption strip during its window, and `camera:reveal-early` flags a reveal object held whole in frame before its cue. Thresholds, severities, the easing model and the sample rate live in `doctrine/qa/camera-path.yaml`. `runL0` takes the track as an optional sixth argument, and `cameraPathFromMap` builds one from a compiled map track.
