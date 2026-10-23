---
"@titan-design/factory": minor
---

A coordinator may answer an `sh-sent-back` gate with exactly `{"decision":"await-new-head"}` while the PR is open at the head the gate asks about (owner decision 529). `gate resolve` reads the PR fresh and stores it as `pr-at-head` evidence, which the gate store re-checks; a moved head, a closed or merged PR, or any other payload falls back to the owner's presence dialog. `approve-merge` and every other gate keep their existing rules.
