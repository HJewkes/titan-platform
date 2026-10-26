---
"@titan-design/factory": patch
---

In an agent env (AGENT_CHAT_AGENT_ID set) with no titan-factory serve answering, `land`, `resume`, `toolchain fanout` and the shepherd verbs that write (merge, review, release, hold, resync, repair-stop, repair-go) now exit 69 with the same unanswered-serve message `register` uses, instead of running in-process. Each verb probes serve once and uses that one answer both to pick serve or the local path and to refuse. `resume` and `toolchain fanout` gain `--port`. `gate resolve` is unchanged: its in-process work is a database write the resolver policy already governs. Read verbs keep their local fallback; without the env var nothing changes.
