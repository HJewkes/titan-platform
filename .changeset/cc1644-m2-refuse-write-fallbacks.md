---
"@titan-design/factory": patch
---

In an agent env (AGENT_CHAT_AGENT_ID set) with no titan-factory serve answering, `land` and the shepherd verbs that can reach a port write (merge, review, release, hold, resync, repair-stop, repair-go) now exit 69 with the same unanswered-serve message `register` uses, instead of running in-process. `resume`, `gate resolve` and `toolchain fanout` have no serve route, so an agent env refuses them outright. Read verbs keep their local fallback; without the env var nothing changes.
