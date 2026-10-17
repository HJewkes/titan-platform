---
"@titan-design/factory": patch
---

The review packager's brief now points at the `titan-review` CLI: it runs `packet from-ci --clone <seat checkout>` once and first, follows `packet prompt`, never re-runs from-ci (it replaces the packet dir, `prose.json` with it), and finishes with `packet lint <dir> --gate-head <head> --require prose --clone <seat checkout>`, which must exit 0. The packager starts in the seat checkout. Every command names the binary by absolute path: new `shepherd.titanReviewBin`, default `$HOME/.local/bin/titan-review`. A head with no visual CI run, or a repo with no usable seat checkout, spawns no packager and records `visual-packet-spawn-failed` with the reason, in `shadow` as in `on` (TP-3196).
