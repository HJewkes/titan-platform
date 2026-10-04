---
"@titan-design/tool-guard": patch
---

`xargs -0`, `--null` and `-d` now split appended input on their separators without `-I`, so `printf 'push,origin,HEAD:main' | xargs -d, git` reads as a push to main. A bare `-0` is recorded as a separator, and an unreadable `-d` value adds a reading per input character so it fails closed.

The value-taking long options `--delimiter`, `--arg-file`, `--max-procs`, `--max-chars` and `--process-slot-var` now consume their separate value, so `xargs --delimiter , git` reads `git` as the command.
