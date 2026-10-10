---
"@titan-design/factory": patch
---

Shepherd never wakes a fixer on a held run. A ci-red repair, a FIX_FIRST send-back or a conflict on a held run spends no repair and starts no agent; the run's seat (its policy seat, else `shepherd.hubSeat`) gets one notice per hold, head and cause, and the run waits. On release the normal repair path resumes at the same head.
