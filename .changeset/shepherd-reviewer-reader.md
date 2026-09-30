---
"@titan-design/factory": minor
---

Add `transcriptReviewerReader`, the production `ReviewerReader` for Shepherd. It finds the dispatched reviewer on the roster by agent id and reads its transcript only once the agent has exited in the dispatched session. It returns one message per assistant text part, in file order, with the session-read locator of that part. It returns nothing unless the whole file was read and the conversation ends with assistant text, so a reviewer must end its turn with the verdict as text. User messages and copied history are excluded, and a message with no usable timestamp is kept.
