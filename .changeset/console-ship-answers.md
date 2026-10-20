---
"titan-console": patch
---

Ship rounds: the Ship and Send back card now comes after every question, so an answer to a question below the Ship decision is sent with it, and the side questions lock once the answer is sent. An unanswered required question no longer turns Ship off (decision 166); it still holds Send back. Ship rounds share the round answer state, so digit keys answer the active question, a question over two frames draws as an A/B and its option notes are sent.

Send back is off, with the reason beside it, while every comment is marked Follow-up and there is no round note: the factory drops follow-up comments from the fixer's note and refuses an empty one. `rounds.submit` refuses that Send back the same way.
