---
"@titan-design/factory": minor
---

The digest config gains `copyDirs`, a list of directories each digest is copied to; a failed copy warns naming the directory and never fails the run. `icloudDir` still parses as a legacy alias and joins the list.
