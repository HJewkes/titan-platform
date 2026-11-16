---
"@titan-design/factory": minor
---

Route reviewer follow-ups below medium severity to a weekly digest instead of the task list. Shepherd's `sh-follow-ups` step and `shepherd follow-ups` still file medium and high follow-ups as tasks. Low ones become rows in `<active-work root>/<initiative>/sources/follow-up-digest.jsonl`, and the step result lists them under `digested`. Each write to the digest drops rows older than 4 weeks unless they carry `promoted`. `shepherd follow-ups` files nothing for a PR whose Shepherd run stopped and prints `skipped: "stopped"`. If it cannot read Shepherd's runs, it files nothing and exits 69.
