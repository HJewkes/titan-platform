---
"@titan-design/tool-guard": patch
---

Refuse a Bash line that defines a shell alias (`alias y=git`, `enable -a`, a store into zsh's `aliases`, `galiases` or `saliases`, bash's `BASH_ALIASES`), with its own hook reason, because zsh expands an alias in text it parses later in the same process and the guard read `y push` as an unknown program (TP-2705). The matcher no longer reads a tilde or other path command word, a glob no alias name matches, a lone `case` pattern word, `print "$?"`, a `printf` format that opens with text or a run-time command word with a `NAME=VALUE` operand as a definition. Exports `AliasDefinitionError` from `@titan-design/tool-guard/shell`.
