---
"@titan-design/factory": patch
---

In an agent env (AGENT_CHAT_AGENT_ID set) with no titan-factory serve answering, `land`, `gate resolve`, `resume` and the shepherd verbs that can reach a port write (merge, review, release, hold, resync, repair-stop, repair-go) now exit 69 with the same unanswered-serve message `register` uses, instead of running in-process. `resume` and `gate resolve` gain `--port`. Read verbs keep their local fallback; without the env var nothing changes.
