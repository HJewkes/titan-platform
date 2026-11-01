---
"@titan-design/session-analytics": minor
"@titan-design/session-miner": minor
---

Lead the daily friction audit with friction measured from worker transcripts. session-analytics gains `transcriptSignals` (denials and tool errors through insights Q5's classifier, in-turn waits over five minutes, and repeated commands and test re-runs with no edit between), `followUpSignals` (insights Q6's brief-fix and correction classes), `readWorkerSessions` and `readSpawnerMessages`, and a per-agent agreement between log and self-report. Q5's `classifyError` and Q6's `classifyFollowUp` move into session-analytics, and the miner's insights now import them. `frictionDailyReport` now takes `{ reports, logs, window }` and returns `logs`, `reports` and `agreement`. Report lines that are scope notes, or `Concerns:` lines that name no friction cause, are set aside as non-friction, and `ci-wait` needs a wait word. The renderers move to `renderLogTop` and `renderReportTop`. `titan-miner friction-daily` gains `--profiles <dir>`.
