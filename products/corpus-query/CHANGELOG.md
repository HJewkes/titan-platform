# @titan-design/corpus-query

## 0.1.0

### Minor Changes

- c547253: Add the pure judge core: a byte-stable judge prefix carrying the owner rulings, token-budget batches with the canary last, and verdict verification that checks each quote against the passage it was reported for, caps quotes at 25 words and scores the canary.
- a74a596: Add exhaustive AND-of-ORs passage retrieval with merged paragraph windows and stable passage ids, and the zero-model `corpus-query hits` command.
- a9b5528: Add the corpus-query product scaffold: the CorpusLayout port with archive and plain layouts, header and story-order parsing, and a contentless paragraph span index behind `corpus-query index`.
- 4ea511b: Add `corpus-query ask` and `corpus-query resume`: separate compile and answer workflow runs, screen on haiku and confirm on sonnet through bare `claude-print` calls, a warm call before each wave, one sonnet redo before a batch is recorded unjudged, grow to a fixed point under a round cap, confirm per book, and a per-call `cost.json`.

### Patch Changes

- 4bcf084: Let the confirm judge exclude a passage with `included: false`, record the resolved model id in `cost.json`, score canaries by whether they claim a match, reserve a confirm share of the budget and count in-flight calls against it, and tell the confirm judge to row the earliest passage of a win.
- b2cc743: Keep a failed judge attempt's spend in `cost.json` even when a crash left it out of the run journal, and reject out-of-range `ask` flags (`--rounds`, `--concurrency`, `--budget-usd`) with an error naming the flag.
- b2cc743: Cut judge cost: prompt caching off for judge calls, a failed screen batch is redone on haiku before the sonnet fallback, and batch messages label passages `P1`…`Pn` instead of full passage ids.
- c378bfb: Add the merge, Discord and markdown render, and cost report: dedupe verified rows, split dense Discord messages on row boundaries, and price a run's usage against the baseline.
- 2dd7bab: Add a `youtube` layout: `.md` transcripts with YAML front matter, the video id as ref, `[mm:ss]` paragraph anchors read by `paragraphAnchor`, and `.score.json` / `.digest.md` siblings indexed under the same ref.
- Updated dependencies [ff061ba]
- Updated dependencies [9386796]
- Updated dependencies [e8159b1]
- Updated dependencies [cca108a]
- Updated dependencies [4ea511b]
- Updated dependencies [2917ad8]
- Updated dependencies [211db45]
- Updated dependencies [eaa03c2]
- Updated dependencies [2256a3b]
- Updated dependencies [b3f677b]
- Updated dependencies [84d962e]
- Updated dependencies [6c2df6a]
- Updated dependencies [c58d555]
- Updated dependencies [67aa361]
- Updated dependencies [9b42150]
- Updated dependencies [c1f9297]
- Updated dependencies [646f4d7]
- Updated dependencies [5e34e3d]
- Updated dependencies [869014a]
- Updated dependencies [869014a]
- Updated dependencies [d46cbce]
- Updated dependencies [ae64085]
- Updated dependencies [1b0c46a]
- Updated dependencies [1bc6431]
- Updated dependencies [342c6ba]
- Updated dependencies [342c6ba]
- Updated dependencies [0100482]
- Updated dependencies [4a2495f]
- Updated dependencies [0229ba6]
- Updated dependencies [ee64f09]
- Updated dependencies [2165cec]
- Updated dependencies [50fd2a5]
  - @titan-design/agent@0.7.0
  - @titan-design/agent-protocol@0.10.0
  - @titan-design/evidence@0.5.0
  - @titan-design/workflow@0.14.0
  - @titan-design/hitl@0.10.0
  - @titan-design/store-sqlite@0.5.0
