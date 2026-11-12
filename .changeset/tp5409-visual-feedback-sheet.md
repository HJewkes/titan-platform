---
"@titan-design/factory": minor
"titan-console": minor
---

Add the post-merge visual feedback sheet (TP-5409, gate model S6). `titan-factory shepherd visual-week-feedback --repo owner/repo [--week YYYY-Www] [--file]` collects the PRs Shepherd merged in an ended ISO week with `visualChanged` recorded on their merge evidence. It builds one round of `kind: "feedback"`, with a section and an optional notes question per PR and no merge-bound question. With `--file`, it files the round through `titan-console decisions file`. The command builds nothing unless `shepherd.visualGate` is `async`. The console round schema now accepts `kind: "feedback"` and refuses a feedback round that has a merge-bound question.
