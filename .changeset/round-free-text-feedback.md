---
"titan-console": minor
---

Every review round now takes free text. Each question of every kind, in question, design and Ship rounds, has an optional comment box, sent as that answer's `comment` with or without a pick. A comment alone does not answer a required question. Each round has a "Feedback on this round" box, sent as `general`. Once a round is sent, `rounds.get` carries the comments and the general text as `notes`, and the page shows them read-only.
