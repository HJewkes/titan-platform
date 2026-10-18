---
"titan-console": patch
---

Add the theater's video catalog. `TITAN_CONSOLE_VIDEO_ROOTS` names the directories to list; `videos.list` returns every mp4 and webm under them by opaque id, with captions and render-notes flags, or one gap line when unset. `GET /media/videos/:id` serves a listed video with byte ranges and `/media/videos/:id/captions` its `.vtt`; each request re-checks that the real path stays inside its root, and anything else answers a fixed 404. The dev server forwards `/media/*` to the daemon.
