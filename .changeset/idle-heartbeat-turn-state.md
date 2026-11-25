---
"@titan-design/session-read": minor
"@titan-design/titan": minor
---

`readClaudeTurnState(path)` reads a Claude Code transcript's tail and says whether the session is between turns (`idle` with the time its last turn ended), mid-turn (`busy`) or unreadable (`unknown`). `titan heartbeat idle --idle <duration> --prompt <text> [--max <duration>] [--stop-cmd <command>]` uses it to wake a session once it has gone a set time without a turn, then exits with one wake line that carries its own re-arm command.
