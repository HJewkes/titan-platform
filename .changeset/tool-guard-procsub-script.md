---
"@titan-design/tool-guard": patch
---

TP-3256: read a process substitution a shell or `source` runs as its script. `bash <(echo 'git push origin HEAD:main')`, `sh <(printf …)`, `source <(echo …)` and `bash <(cat ./x.sh)` are now walked like the same text piped in, and a `cat` of a file the guard cannot read in full is refused. A body the guard does not model (`kubectl completion bash`, `curl …`) keeps the verdict the same program piped into the shell gets. A body's pipeline passes printed text through `cat` and `tee` (`bash <(echo … | cat)`), and once a shell runs a substitution as its script every later substitution operand is read too, since the script may run it by its positional (`bash <(echo 'bash "$1"') <(echo …)`).
