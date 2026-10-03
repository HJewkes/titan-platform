---
"@titan-design/agent-surface": patch
---

Time out the iTerm `osascript` calls (10 s) and the launch-check `ps` call (5 s) with `SIGKILL`, so an Automation prompt or a wedged iTerm2 no longer blocks surface open and close forever. A timeout reads as unknown, never present or gone.
