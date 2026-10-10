---
"@titan-design/tool-guard": patch
---

Refuse a Bash command whose line ends while a `$( )` or `<( )` it closed still has a heredoc open, including one inside `${...}` or `$((...))`. Bash 5 reads that heredoc's body from the following lines and moves the bodies of the line's own heredocs further down. Bash 3.2 runs those lines as commands instead. With the two readings that far apart, a quote in a body could hide a later `git push` from the guard. The hook now denies such a line unchecked, whatever it names, with a reason that says to close the heredoc inside the substitution. A heredoc closed inside its substitution, such as the usual `git commit -m "$(cat <<'EOF' … EOF\n)"`, is unaffected.
