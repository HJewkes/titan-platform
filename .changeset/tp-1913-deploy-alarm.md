---
"@titan-design/factory": minor
---

serve keeps a deploy alarm: `/health` and `shepherd status --json --deploy` carry a `deploy` block (running sha, green-merge deploys asked for that have not landed and how long the oldest has waited, refusals in a row, last refusal reason with a stale `.git/index.lock` report), and the configured `shepherd.hubSeat` gets one agent-chat message when the alarm goes up.
