---
"@titan-design/factory": minor
---

Add `POST /gates/answer-ship`, mounted by serve only when `shepherd.consoleAnswers.roundsDir` is configured. It resolves an approve-merge gate as `owner-remote` (`titan-console`, `console:ship`) from a console Ship answer once the gate, GitHub's head and tree, the round's packet and the owner's feedback all agree, and appends a `pick-later` line to `follow-ups.jsonl` for `merge-pick-later`. It is no registry command and no MCP tool.
