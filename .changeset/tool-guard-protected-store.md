---
"@titan-design/tool-guard": patch
---

Read stores into any set of protected parameter names through one reader, `writesProtectedParam` (`writesHookedParam` is that call over the hooked names), and teach it the writers it missed: `zpty -r`, `zsystem flock -f`, `syserror -e`, `sysopen -u` (with `-m` taking a value), `syswrite -c`, `zmodload -F -l -P`, `zgetattr`, `zlistattr`, `ztie`, `zcurses input`, `shift`, `compadd -O/-A/-D`, `compquote`, the zsh/computil builtins, and `{name}>file` descriptor-variable redirections. A checked-in list tags all 152 zsh 5.9 builtins as writer or non-writer, and a comparison with a live zsh fails when a builtin is in neither. A word in option position that is not wholly quoted and may brace-expand, glob or tilde-expand into an option, such as `print ""{-v,PS4} x` or `print -[v] PS4 x`, counts as a write (TP-3175).
