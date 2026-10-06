---
"@titan-design/decider": minor
---

Add the `ask-lint <file> [--section <heading>] [--json] [--strict]` bin. It runs `lintMorningList` on the whole file, or `lintOwnerQuestions` on the one section `--section` names, and prints one `<item id> <rule> <evidence>` line per finding (one JSON object per finding under `--json`). It exits 0 by default, 1 under `--strict` when any finding exists, and 2 with one stderr line on a missing file or section heading.
