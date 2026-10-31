# @titan-design/yt-scout

## 0.1.0

### Minor Changes

- 218bce9: Add `titan-yt-scout detect [--dry-run]` (TP-4377, Y-15 slice S2). It polls each source's RSS feed, falls back to a yt-dlp flat listing with a `fallback` step row when RSS fails, keeps only matching search hits, skips ids already in `videos`, and files shorts, live, upcoming and over-long videos under their filtered state.
- aba431d: Add the digest step (TP-4380, Y-15 slice S5): for a card at or over the threshold, retrieve earlier passages and existing tasks through the `corpus-query` and `active-work` CLIs, make one bare headless Opus call with the `digest.v1` template, and write `<id>.digest.md` beside the transcript. At most three digests are written a day; a card under the threshold makes no call.
- 8f34b23: Add the eval loop (TP-4383, Y-15 slice S9): `titan-yt-scout flag` records an owner verdict as a case holding input shas, `eval replay --model` prints threshold-side agreement, mean absolute difference and cost, and `eval audit` re-scores a weekly sample on a stronger model.
- e81daef: Add `products/yt-scout`, the scheduled AI-video scout (TP-4372, Y-15 slice S1). `titan-yt-scout config check` validates the owner's watch list against a strict schema and names the line of each problem; `titan-yt-scout seen import` loads the pre-scout inventory, scores, watch-later picks and transcript ids into the SQLite `videos` table, and a rerun adds nothing. Detect, transcribe and score are typed seams for later slices.
- 315e569: Add `titan-yt-scout score <id>` (TP-4379, Y-15 slice S4): one bare headless Sonnet call scores a transcript against the rubric into a `ScoreCard`, drops techniques whose `ts` is not a transcript anchor (filing a `ts_invalid` eval case), and appends a step row with cost, `prompt_sha` and `input_sha`.
- dacaa86: Add `titan-yt-scout transcribe` (TP-4378, Y-15 slice S3). It runs extract.py one video at a time with a persistent circuit breaker on HTTP 429, the no-captions and live retry schedule, and a Whisper gate on queue length and load.

### Patch Changes

- Updated dependencies [ff061ba]
- Updated dependencies [9386796]
- Updated dependencies [e8159b1]
- Updated dependencies [cca108a]
- Updated dependencies [4ea511b]
- Updated dependencies [2917ad8]
- Updated dependencies [d666020]
- Updated dependencies [211db45]
- Updated dependencies [a5f2f40]
- Updated dependencies [2c20516]
- Updated dependencies [5993fba]
- Updated dependencies [5cd2a5a]
- Updated dependencies [cda1b03]
- Updated dependencies [7835f1b]
- Updated dependencies [c58d555]
- Updated dependencies [9b42150]
- Updated dependencies [c1f9297]
- Updated dependencies [5e34e3d]
- Updated dependencies [869014a]
- Updated dependencies [6d79a8b]
- Updated dependencies [36e0a48]
- Updated dependencies [20c93ed]
  - @titan-design/agent@0.7.0
  - @titan-design/owner-queue@0.6.0
  - @titan-design/store-sqlite@0.5.0
