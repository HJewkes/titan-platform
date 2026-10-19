---
"titan-console": minor
---

Add pause-to-comment, scrub markers and verdicts to the theater player. "Comment at m:ss" pauses the video and stamps the note with the presented frame's `mediaTime` from `requestVideoFrameCallback`, falling back to `currentTime`. On a phone the bar is fixed along the bottom of the screen. Ship and Needs changes append a verdict at the frame on screen. A refused owner write is shown verbatim. A strip under the video carries one tick per note on the current render, and tapping a tick seeks to it.
