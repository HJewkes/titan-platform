---
"titan-console": patch
---

The console inbox gives an agent-chat permission prompt or endorsement an `approve-chat` tap. `inbox.prepare` reads the broker's own queue row back (tool, input preview and description, or the exact stored text and recipient) and offers no tap for any other row. `inbox.act` posts the owner's allow, deny or endorse verdict through the broker verdict client once, and a refusal names the terminal command.
