---
"@titan-design/tool-guard": patch
---

Read `&&` and `||` inside `[[ ]]` as words of that one command, but only when the `[[` is the first word of a line or follows a control operator (`;` `&` `&&` `||` `|` `|&`, newline, an opening `(`). Every other `[[` keeps the split reading, so `[[ -n $x && $y == z ]] # c` no longer reads as a command with a dynamic name, and nothing after a prefix word can hide a command inside a `[[`.

Joining is opt-in: `extractCommands` splits unless called with `joinsConditional: true`, which `classify` passes only for the Bash tool's own line, and which holds back when the line mentions an alias or has a step the guard cannot read. Nothing a nested shell reads joins: a `-c` string, heredoc, here-string, piped text, `eval` text and script files keep the split reading, because the runner's name does not say which shell runs (a function, a `PATH` entry or a hash can rebind `bash`). Accepted false positive (FP10): a `[[ x && y ]]` or `[[ x || y ]]` in such text keeps the split reading, so a protected command after `||` inside it is reported and a dynamic word after `&&` is refused. Run the test on the Bash tool's own line, or write `[ x ] && [ y ]`.
