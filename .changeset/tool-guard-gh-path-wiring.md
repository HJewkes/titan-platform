---
"@titan-design/tool-guard": patch
---

A gh command whose group or verb is only known at run time (`gh $X`, `gh pr $X 5`, `gh -R o/r $X`), whose last command word gh may run as an alias or extension, or whose prefix points gh at another config, now reads as `bash.merge.gh-pr-merge {}`, `bash.release.gh-release {tool: "gh"}` and `bash.egress.gh-gist` at once, and as a switch to an unknown head, so a later push counts as protected (TP-2703 b). A dynamic command word read as gh counts only a run-time word after it, so `"$EDITOR" file` still passes. Literal gh paths keep their verdicts.
