---
"@titan-design/tool-guard": patch
---

Read a script the line writes from the line, not the disk. A file written through a `>`, `>|`, `>>`, `&>` or `>&` redirect by a `cat` heredoc or here-string, `echo` or `printf` whose output is literal holds that text for the rest of the line, so a push or merge in it is denied when the same line then runs it with `.`, `source`, `bash` or `sh`, whether or not the file already exists and whatever it held before. An append adds to what was known. A write whose text is only known at run time (`curl … > s.sh`, a dynamic command, `tee`) leaves the file unknown rather than reading stale disk text, as before for unknown scripts. Where bash's and zsh's `echo` print differently, the file holds both readings.
