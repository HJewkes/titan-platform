---
"@titan-design/owner-queue": minor
---

Add `byRecRoundSubject` (TP-6775): the one builder from a round@2 question to a `ByRecSubject`, so every reader of a round judges the same facts. Its `text` holds the prompt, the section or round context, the option labels and option details, so a dollar amount in any of them floors the question as money. A pick-one offers its labels and a scale its whole steps as the answers the floor checks; a pick-many offers none and refuses as answer-unsound.
