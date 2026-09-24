---
"@titan-design/session-graph": minor
"@titan-design/session-analytics": minor
---

Add `start_transcript_id`/`end_transcript_id` to the `episode` table (migration 6, "episode transcript ids") and thread `transcript_id` through `session-analytics`'s episode input so a session resumed across two transcripts still segments in time order instead of falling back to byte offsets that reset with the new file.
