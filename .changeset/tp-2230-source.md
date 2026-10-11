---
"@titan-design/tool-guard": patch
---

Read a script the line writes from the line as well as the disk. A file written through a `>`, `>|`, `>>`, `&>` or `>&` redirect by a `cat` heredoc or here-string, `echo` or `printf` whose output is literal gains that text as a reading for the rest of the line, so a push or merge in it is denied when the same line then runs it with `.`, `source`, `bash` or `sh`, whether or not the file already exists. A write only adds a reading and never replaces what the file held, since it may sit behind `&&`, in a body that never runs, in the background or under noclobber; an append adds each earlier reading with the text after it, keeping the newline `echo` and a here-string end with. A write whose text is only known at run time (`curl … > s.sh`, `cat other > f`, `tee`) adds nothing. A line that runs a script it left more than 16 readings of is refused unchecked; a file nothing runs, such as a PR body built with appends, is never refused.
