---
"@titan-design/factory": patch
---

Serve's main CI watch now logs a `main CI watch ALARM` error, at startup and again whenever the set changes, for each seat a red event would go to (a watched repo's seat, else `shepherd.hubSeat`) that no live agent-chat session holds. Before this, a send to a dead seat failed and was retried quietly every sweep, so no seat heard about a red main.
