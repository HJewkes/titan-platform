---
"@titan-design/tool-guard": patch
---

printedText reads each shell's escapes: bash's echo decodes only with a final `-e`, zsh's `-e` beats `-E`, and a printf format's `\c` prints as written (bash, shell-less) or ends output (zsh), so `printf 'echo \c; git push …' | bash` is denied.
