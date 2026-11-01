---
"titan-console": minor
---

Keep the inbox's Blocking section to items whose answer unblocks running work (TP-4352). Each source has one rule: a hitl gate blocks while its live Shepherd run is pending on it at a PR head; a deposit with a gate, merge or hold op blocks while the live run sits at the op's head, a close-pr or retire-agent op never blocks, and any other deposit or agent-chat ask blocks while its asker is live in the broker roster; an open round blocks. Morning lines and active-work tasks move to Planning. A round of several questions is one row, `round:<round id>`, showing its question count.
