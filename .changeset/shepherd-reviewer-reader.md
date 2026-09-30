---
"@titan-design/factory": minor
---

Add `transcriptReviewerReader`, the production `ReviewerReader` for Shepherd: it finds the dispatched reviewer on the roster by agent id, reads its transcript only once the agent has exited in the dispatched session, and returns one message per assistant text part with the session-read locator of that part. User messages and copied history are excluded, and a message with no timestamp is kept.
