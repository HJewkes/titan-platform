---
"@titan-design/factory": minor
---

`titan-factory context-audit` prints wakes by trigger per coordinator: Shepherd digests, Shepherd per-PR notices, Monitor and background task-notifications, agent-chat lifecycle pushes and other broker notices, host-job notices, cron and loop ticks, peer messages, the owner and the spawn brief. Each coordinator's sessions in the window are summed, and only wakes stamped inside the window count. Messages that arrive during a busy turn count too.
