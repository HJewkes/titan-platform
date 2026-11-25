---
"@titan-design/titan": minor
---

`titan heartbeat idle --idle <duration> --prompt <text> [--max <duration>] [--stop-cmd <command>]` wakes a Claude Code session once it has gone a set time without a turn, read from its own transcript tail, then exits with one wake line that carries its own re-arm command. A session mid-turn is never woken, and every turn restarts the idle clock.
