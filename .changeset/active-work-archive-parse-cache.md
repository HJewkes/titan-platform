---
"@titan-design/active-work": patch
---

Reuse parsed tasks for unchanged files in the archive pass `active-work open` runs first. A sidecar under the state directory keeps each task's parsed form, stamped with the file's inode, size, mtime and ctime; a file whose stamp differs, or any problem reading the sidecar, falls back to a full parse.
