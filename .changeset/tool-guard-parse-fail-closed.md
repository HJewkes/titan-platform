---
"@titan-design/tool-guard": patch
---

Deny every Bash command that fails to parse or that the classifier throws on, and tell the agent to simplify it. Before this, such a command passed unless its raw text named a guarded keyword, so a `$( )` nested past the walk limit, or an ANSI-C or expanded spelling such as `git p$'u'sh`, let a push through. Unparseable commands that name nothing guarded now deny too. The owner bypass still passes them, with an error line.
