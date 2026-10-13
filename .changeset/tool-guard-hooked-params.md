---
"@titan-design/tool-guard": patch
---

Add `writesHookedParam`, which names the PS4, PROMPT4, module_path or MODULE_PATH write a command makes (assignment, declaration, nameref, `read`/`for`/`printf -v`/`set -A` and `${NAME:=…}`), and counts any name slot the shell computes (expanded, globbed or braced) as such a write, for the hidden-code refusal to build on.
