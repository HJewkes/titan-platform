---
"titan-console": minor
---

`rounds.submit` writes `feedback.json` the way the review harness does (TP-1988). Each answer to a recommended question echoes its recommendation, with `agreed` once answered. A pick-one answer echoes the picked option's `after`. A pick of the round's `revisionOption` is written as `revisionRequested`. Every frame is echoed with a null verdict, answers are kept in round order, and a Ship round sent with questions left unanswered lists them in `unansweredQuestionIds`. Before the file is created, the document is checked against its round, and any problem refuses the submit with nothing written: a required question left unanswered outside a Ship round, or a revision request with no comment. titan-review's `calibration` can now score console rounds. The gate-answer listener reads `feedback.json` with the 0.3 `FeedbackSchema`, and it relays a revision request on a Ship question as a Send back.
