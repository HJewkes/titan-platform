---
"@titan-design/factory": minor
---

Let the owner send a PR back from the approve-merge gate. With `shepherd.consoleAnswers` configured, each shepherd-pr approve-merge gate offers `send-back`, whose payload `{decision: "send-back", headSha, note}` the gate store refuses without a note. Land stops `sent-back`, and Shepherd wakes the implementer's review fix with the note, then waits for a new head and never merges the sent-back one. `POST /gates/answer-ship` now resolves an agreed send-back, taking the note from the owner's `feedback.json` (the round's `general` text, then the Ship question's `comment`).
