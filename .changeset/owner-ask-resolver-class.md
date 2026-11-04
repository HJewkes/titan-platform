---
"@titan-design/authority": minor
"@titan-design/factory": minor
---

Add the `owner-ask` gate resolver class (TP-4763, owner decision 552). `@titan-design/authority` lists `owner-ask` as an actor class that is never an owner class, and the table denies it every action (17 new `*-OA` deny rows). `titan-factory gate resolve --owner-ask` lets a seat answer a gate after the owner approved that exact command at a Claude Code permissions.ask prompt. The approval cannot be verified, so the gate records `{ class: "owner-ask", id: <seat>, channel: "factory-cli" }`. The factory store admits it only on an approve-merge land gate whose policy rule is not publish, device or owner-presence, and refuses every other gate with the rule named.
