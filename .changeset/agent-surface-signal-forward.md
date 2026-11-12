---
"@titan-design/agent-surface": minor
---

`runAgent` forwards SIGTERM, SIGINT and SIGHUP to the agent and logs one stderr line per signal (time, agent, signal, ppid, pgid) and one line with the agent's exit code and signal. A throwing `onSpawn` now kills the child and rethrows. An interactive launch logs SIGINT without forwarding it, since the terminal already delivers it.
