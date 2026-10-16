---
"titan-console": minor
---

Relay a submitted Ship or Send back to the factory's approve-merge gate. With `TITAN_CONSOLE_GATE_ANSWERS=1` (default off), a `rounds.submit` that writes a merge-bound round's `feedback.json` reads Shepherd's status row for the PR and, only when its head is the head the round showed, posts the answer to the factory; the result is kept once in the round's `answer.json`. A moved head or a closed gate is recorded without a post, and a factory that is down leaves no file for the start-up sweep to retry.
