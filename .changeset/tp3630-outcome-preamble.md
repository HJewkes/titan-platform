---
"titan-console": patch
---

Answer an agent's chat question from the inbox behind a fixed outcome preamble (TP-3630). The text sent to the broker now starts with one line naming the chat msg it answers and asking the agent to record a durable outcome on that item (task note, PR comment or reply). The action record and the decision log keep the owner's words unchanged.
