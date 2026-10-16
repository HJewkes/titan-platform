---
"@titan-design/tool-guard": patch
---

A shell that a `-c` string, `eval`, `emulate -c` or `find -exec` starts now inherits its runner's stdin and descriptors (TP-3250). `echo TEXT | eval 'bash /dev/stdin'`, `eval zsh <<< TEXT`, `emulate zsh -c 'sh -s' <<< TEXT`, `echo TEXT | bash -c 'bash /dev/stdin'`, `eval 'bash /dev/stdin' < ./x.sh` and `find . -exec bash /dev/stdin \; < ./x.sh` read what the inner shell runs, and `bash -c bash < $F` is refused, since the line cannot show `$F`.
