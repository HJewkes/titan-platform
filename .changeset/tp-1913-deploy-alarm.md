---
"@titan-design/factory": minor
---

serve keeps a deploy alarm: `/health` and `shepherd status --json --deploy` carry a `deploy` block (running sha, merges and minutes behind origin/main, refusals in a row, last refusal reason with a stale `.git/index.lock` report), and the configured `shepherd.hubSeat` gets one agent-chat message when the alarm goes up.
