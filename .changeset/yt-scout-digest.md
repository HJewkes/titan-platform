---
"@titan-design/yt-scout": minor
---

Add the digest step (TP-4380, Y-15 slice S5): for a card at or over the threshold, retrieve earlier passages and existing tasks through the `corpus-query` and `active-work` CLIs, make one bare headless Opus call with the `digest.v1` template, and write `<id>.digest.md` beside the transcript. At most three digests are written a day; a card under the threshold makes no call.
