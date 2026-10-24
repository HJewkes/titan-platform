---
"@titan-design/explainer": minor
---

The daily gather adds a stats round:
- From `active-work miner cost`: the day's spend, split by account, and cost per merged PR.
- From `active-work miner cost` and `gh search prs`: a seven-day trend of spend and merges, labelled `MM-DD: number`.
- From `titan-factory shepherd stats`: slowdowns, meaning owner touches and gate waits for the day, stage medians for the ISO week, and tasks newly owner-gated.

The spend facts name the price table that priced them, and a note says when that table is older than the current one. A failing CLI costs its facts and leaves a note; the gather still completes. Open tasks carry their priority rank, and each lane's two lowest-ranked open tasks become `next/<task>` facts. Session rows stay in `digest.json` but leave `facts.md`, which keeps one `sessions/rollup` row in their place.
