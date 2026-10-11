---
"@titan-design/session-read": minor
---

`orientationEnd(brief, briefingChars?)` and `assignedTaskIds({ ..., briefingChars? })` accept the recorded orientation length (agent-chat's `agent_spawned` meta `briefing_chars`) and use it in place of the heading text, so a heading rename no longer stops task linking.
