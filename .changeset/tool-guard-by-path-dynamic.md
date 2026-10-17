---
"@titan-design/tool-guard": patch
---

Read a by-path script named by a dynamic command word or a changed `PATH` (TP-3338 b). A run-time command word whose own text or substitution holds a `/` fails closed; a bare name under a `PATH` that lists a relative directory (`PATH=.:$PATH s`) reads the file of that name there, including a file the line writes; a `PATH` the walk cannot read refuses a bare command after it. A name stored first and expanded later (`f=$(echo ./s); $f`, array elements, `"$@"`) is still not read. An unchanged `PATH` keeps its reading.
