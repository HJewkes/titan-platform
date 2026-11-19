---
"titan-console": minor
---

Show before and after frames on the visual ship rows of `#/log` (TP-6777). When the log is built, a visual ship row without frames has its pr-visual pairs written through `titan-factory shepherd log-frames` into `<state>/log-frames/<owner>/<repo>/<pr>/`. The console then writes `frames.json` (titan-review/frames@1) there once, so a later build reads it and the row keeps its frames after the artifact expires. One build starts at most three captures. A failed read writes nothing, shows as a gap line and is tried again on the next build. A PR whose artifact is missing or rendered nothing shows one `no visual evidence: <reason>` line. Each row shows thumbnails that open full size, served by the new `log.frame` read, which checks each PNG against the sha256 recorded in `frames.json`.
