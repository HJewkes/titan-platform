---
"@titan-design/agent-surface": minor
---

`RunAgentOptions` gains `onSpawn?: (child: ChildProcess) => void`, called once right after the agent is spawned and before the brief is written. Nothing changes when it is absent.
