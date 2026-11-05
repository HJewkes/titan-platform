---
"titan-console": minor
---

Give theater comments two kinds, each told to its own seat. The comment box asks whether a comment is about the content or about the video itself, and each `titan-console/video-note@1` comment line gains `about: "content" | "video"`; a line written before reads as content. `videos.note` messages the seat a comment belongs to through the round notices' agent-chat transport: a content comment goes to the video's new optional `owner` sidecar field, else video-coord, and a comment about the video always goes to video-coord. It returns `routedTo: { seat, delivered }`. The player's note list shows each comment's kind and filters by it, the feed counts comments about the video, and those comments no longer count as open for the rendering agent.
