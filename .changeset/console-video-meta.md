---
"titan-console": minor
---

Read a `titan-console/video-meta@1` sidecar (`<stem>.video.json`) and a `titan-console/video-folder@1` manifest (`_videos.json`) into `videos.list`. Each row gains whichever of `purpose`, `tags`, `subject`, `parent`, `posterAtS`, `alias`, `title`, `description`, `series`, `take` and `status` are set. A sidecar beats the manifest. A bad file becomes a gap line instead of a failed list. A video with neither file lists as before.
