---
"@titan-design/session-read": minor
---

Add `parseReviewVerdicts`, a pure parser for approve / changes-requested verdicts in a
`chat_send` message, and the `review_verdict` event: `readToolUse` emits one per parsed
verdict from any tool whose name ends in `__chat_send`, carrying the verdict, the PR
reference (an exact repo, a repo hint, or neither) and the tool call's `cwdRepo`. No message
text or excerpt is stored on the event. Resolving the repo and filtering by sender profile
are session-graph's job.
