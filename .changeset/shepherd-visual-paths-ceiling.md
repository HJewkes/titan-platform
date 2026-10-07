---
"@titan-design/factory": minor
---

Shepherd seats can list `visual_paths` globs. Such a seat merges a pull request without the owner when, at the head being decided, no changed file matches a glob and `MRG-AU-RV` holds (reviewer `MERGE` at that head plus green required checks). A head that changes a visual file gates on `visual-path` and names the files. A changed-file list that failed to read or was truncated gates on `files-unread`. A remote shared by several seats gets the union of their globs. Seats without `visual_paths` are unchanged.
