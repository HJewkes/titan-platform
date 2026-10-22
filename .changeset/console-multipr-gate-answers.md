---
"titan-console": patch
---

The gate-answer listener relays every merge-bound question of a multi-PR round, one post per PR to its own gate. A round with one merge question keeps its `answer.json` unchanged; a round with several keeps the first PR's record on top and adds `answers`, each PR's request and outcome under its question id.
