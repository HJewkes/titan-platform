---
"@titan-design/factory": minor
---

Shepherd lands one pull request per repo at a time through a merge train. A run boards the train at its merge step, updates its branch and waits for green CI while it holds the train, merges, and gives the train up when its land round ends. `shepherd status` names the run a waiting run sits behind. The holder lives in the new `shepherd_train` table (migration 10), so a restart keeps it. A holder whose run failed, was cancelled, is paused on a gate, or whose merge is held loses the train to the next run.
