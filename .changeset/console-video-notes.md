---
"titan-console": minor
---

Add the theater's notes store. `videos.note` (owner-write) appends a timestamped comment or a Ship / Needs changes verdict to `<name>.notes.jsonl` beside the video. Each line is a strict `titan-console/video-note@1` object bound to the render's sha256. `videos.notes` reads them back, each marked `current` for the render now on disk, and `videos.list` gains `noteCount` and `verdict`. The README documents the schema and the agent pickup rule (`openNotes`).
