---
"@titan-design/tool-guard": patch
---

Read a by-path script named by a dynamic command word or a changed `PATH` (TP-3338 b). A command word built at run time that holds a `/` (`$(echo ./s)`) fails closed; a bare name under `PATH=.:$PATH` or `export PATH=./bin:$PATH` reads the file of that name in the relative directories listed. An unchanged `PATH` keeps its reading. A `#!` line the guard cannot follow is refused with its own hook reason.
