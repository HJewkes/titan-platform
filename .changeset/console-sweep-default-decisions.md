---
"titan-console": minor
---

`titan-console rounds sweep` falls back to `<active-work root>/claude-channels/sources/autonomy/decisions.md` when neither `--decisions` nor `TITAN_CONSOLE_DECISIONS_FILE` is set, and prints `decisions: <path>`. An absent default file keeps the "no decisions file" line.
