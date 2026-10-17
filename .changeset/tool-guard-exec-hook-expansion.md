---
"@titan-design/tool-guard": patch
---

The lexer refuses a `${…}` that assigns while it expands (`:=`, `::=`, `=`) when its target is a shell exec-hook parameter: the prompts (`PS0`–`PS3`, `PROMPT_COMMAND`, zsh `prompt` and `PROMPT*`), the zsh hook arrays (`chpwd_functions` and the rest), the startup names (`BASH_ENV`, `ENV`, `ZDOTDIR`, `HOME`, `SHELLOPTS`, `BASHOPTS`), the code search paths (`FPATH`, `fpath`, `BASH_LOADABLES_PATH`), the command path (`PATH`, `path`, `NULLCMD`, `READNULLCMD`, `EXECIGNORE`), `IFS`, the dynamic-loader names, zsh `mapfile` and the `dis_aliases`, `dis_galiases` and `dis_saliases` tables. A universe test tags every zsh 5.9 special parameter and bash 5.3 variable, so a name the guard misses fails a test (TP-3293, slice j1 of TP-3189).
