---
"@titan-design/tool-guard": patch
---

Deny a Bash command that fails to parse when its text holds a push or merge word. A `$( )` nested past the walk limit before a `git push` used to fail open.
