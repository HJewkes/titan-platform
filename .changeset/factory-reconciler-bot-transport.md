---
"@titan-design/factory": minor
---

The reconciler has a production bot transport and a `BotPorts` builder (TP-3431 part a). `botTransport(client)` answers the `gates` call with three conditional reads, the open-PR list, the `main` ref and the rulesets, and reports `changed` with the new ETags. A free-plan repo's refused rulesets count as unchanged. It answers the `snapshot` call with `readBackstopSnapshot`. A GitHub failure answers its status, lower-cased headers and message, so the pool classifies it. GraphQL's primary limit, which GitHub returns as a 200, answers as a 403. `buildBotPorts({ client, login, db, clock, observe })` puts the transport behind a `github-api` pool. The pool keeps its state in the factory's pool-state table and probes `GET /rate_limit` as the bot, and the builder sets `conditionalGates: true`. Serve does not use it yet; TP-3431 part d wires it in.
