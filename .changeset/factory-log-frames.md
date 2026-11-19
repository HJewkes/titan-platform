---
"@titan-design/factory": minor
---

Add `titan-factory shepherd log-frames --repo --pr --head --dir` (TP-6777). It writes a shipped PR's changed pr-visual before and after pairs into `--dir` through the same reader the Ship rounds use. It refuses any folder that does not end in `log-frames/<owner>/<repo>/<pr>` for that PR. It reports the packet line, the reason when no pair was written, and `failed` when the read itself failed and is worth trying again.
