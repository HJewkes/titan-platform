---
"titan-console": patch
---

Add the knowledge pages. `work.notes` lists notes and top-level sources across initiatives by their `note:` or `source:` ref, `work.record` reads one by ref and flags a truncated file, and `work.search` returns active-work's search hits by ref; all three are reads, and `note.read` and `search` join the active-work `READS`. `#/knowledge` has a Browse tab with initiative, kind and date filters in the query string and a Search tab keyed on `q`; `#/knowledge/<ref>` renders the record as prose and links to its initiative.
