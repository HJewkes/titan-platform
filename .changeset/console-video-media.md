---
"titan-console": minor
---

`videos.list` reads each video's headers (mp4 `mvhd`/`tkhd`/`hdlr`, webm EBML) into `durationS`, `width`, `height`, `orientation` and `audio`, caching them by device, inode, size and mtime. A file whose headers cannot be parsed becomes a gap line. Rows also gain a derived `title` (render notes H1, then BRIEF.md H1, then the stem, with the take appended when siblings share a title), `description`, `series`, `take` and `superseded`, each beaten by a sidecar value; `copies`, folding identical files under `copies` or `intermediate` folders; and `openNoteCount`, the open notes under the agent pickup rule.
