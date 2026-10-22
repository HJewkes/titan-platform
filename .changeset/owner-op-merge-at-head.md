---
"@titan-design/factory": minor
---

Add the `merge-at-head` owner op (TP-3939 S3). A console tap never merges directly (MRG-OR): if the PR's Shepherd run is already pending on approve-merge at the confirmed head, the tap resolves that gate as owner-remote; otherwise it starts a `land-pr` run with the new `update=false` param, which stops `behind` instead of updating the branch, and records a standing answer in `<stateDir>/standing-answers.jsonl`. A new standing-answer sweep resolves that run's approve-merge only at the exact head the owner confirmed, within 24 hours, and only while no owner-asked hold or repo freeze stops the PR. After the land run completes, the sweep ends the PR's live Shepherd run if GitHub shows it merged. A replay of the same record answers `already`, `moved` or `gone`. The console-action route gains the `accepted` outcome (200).
