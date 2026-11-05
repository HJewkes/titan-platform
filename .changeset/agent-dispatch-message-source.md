---
"@titan-design/agent-dispatch": minor
---

`messageAgent` takes an optional trailing `{ source }` (`WakeSource`: `"watchdog"`, `"shepherd"` or `"console"`), sent as `agent-chat debug send --source <source>` ahead of `--`, so the message arrives labelled `wake_source=<source>` instead of as the owner's words. Without it the argv is unchanged.
