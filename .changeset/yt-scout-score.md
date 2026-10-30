---
"@titan-design/yt-scout": minor
---

Add `titan-yt-scout score <id>` (TP-4379, Y-15 slice S4): one bare headless Sonnet call scores a transcript against the rubric into a `ScoreCard`, drops techniques whose `ts` is not a transcript anchor (filing a `ts_invalid` eval case), and appends a step row with cost, `prompt_sha` and `input_sha`.
