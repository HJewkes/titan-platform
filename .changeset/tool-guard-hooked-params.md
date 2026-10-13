---
"@titan-design/tool-guard": patch
---

Add `writesHookedParam`, which names the PS4, PROMPT4, module_path or MODULE_PATH write a command makes (assignment, declaration, nameref, `read`/`for`/`printf -v`/`set -A`, `${NAME:=…}` and arithmetic: `let`, `$(( ))`, `$[ ]`, subscripts), and counts any name slot the shell computes (expanded, globbed or braced) as such a write, plus `arithmeticHooked` for a `(( ))` span, for the hidden-code refusal to build on.
