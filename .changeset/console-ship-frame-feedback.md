---
"titan-console": minor
---

Ship rounds take frame feedback (TP-3773 S6b). Each Ship montage takes a verdict and comment, sent as `variants` with Ship or Send back. A frame comment, pin or Rejected verdict turns Ship off as a comment does, and `rounds.submit` refuses such a Ship; Chosen or Maybe alone blocks nothing. A frame comment or pin counts as a Send back note. In a round with several PRs a frame counts only for its own PR. An earlier round's frame feedback appears in `priorFeedback` as `frames` lines and holds Ship until ticked Addressed.
