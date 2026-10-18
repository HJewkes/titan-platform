---
"@titan-design/tool-guard": patch
---

Read the printed text of a command substitution that holds a group, subshell, list or pipeline, so a shell or eval that runs it is checked (TP-3333).
A digit fd before a redirect is read as its number, so `01>` and `00<` count as fd 1 and fd 0, and a NUL in a substitution's output leaves its text unknown.
