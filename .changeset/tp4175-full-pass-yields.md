---
"@titan-design/session-graph": minor
"@titan-design/session-analytics": minor
"@titan-design/active-work": patch
---

Full and `--full` index passes no longer hold the event loop for seconds (TP-4175). `refreshCorpus` and `indexTranscript` take a `yieldPoint`. With one, each transcript's delta is applied by the new `applyDeltaYielding` in bounded steps inside one transaction held open across the yields, so it still commits or rolls back whole. The rollup runs one session per transaction with a yield after each. Without a `yieldPoint`, nothing changes. session-analytics adds `staleEpisodeSessionsYielding`, which pages the backlog sweep by session and returns the same list as `staleEpisodeSessions`. active-work's full pass passes its `yieldPoint` to both. On a fixture of 500 transcripts, the longest synchronous chunk of a `--full` rebuild drops from 2380 ms to 141 ms.
