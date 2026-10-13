---
"@titan-design/tool-guard": patch
---

printedText reads each shell's escapes: bash's echo decodes only with a final `-e`, zsh's `-e` beats `-E`, and a printf format's `\c` prints as written (bash, shell-less) or ends output (zsh). printf finds directives before decoding escapes, so an escaped `%` (`\045`, `\x25`) eats no argument, and reads a format after `--`. A print piped straight into a shell is walked under bash's and zsh's texts too, so `printf 'echo \c; git push …' | bash` and `echo -neE 'git\x20push …' | zsh` are denied.
