---
"titan-console": patch
---

`rounds.submit` records each answered question in the console decision log: a decider-readable row in `<state>/answers.jsonl`, and a bullet under `## Queue answers <date>` in `TITAN_CONSOLE_DECISIONS_FILE` for one-way, A/B and policy answers. The submit result gains an optional `log` array.
