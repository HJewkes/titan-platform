---
"@titan-design/tool-guard": patch
---

Add `definesAlias`, which reads whether a command defines a shell alias (`alias y=git`, `alias -g`, `enable -a`, a store into zsh's `aliases`/`galiases`/`saliases` parameters, or a dynamic command word with a `NAME=VALUE` operand), and `AliasDefinitionError`, the reading limit the walk will throw for such a line (TP-2705).
