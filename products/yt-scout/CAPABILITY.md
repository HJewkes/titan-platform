# yt-scout: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You are working on the owner's scheduled AI-video scout (Y-15): the YouTube watch list (`WatchlistSchema`, `loadWatchlist`, line-numbered `WatchlistError`), the `videos` state table (`openScoutDb`, `VIDEO_STATES`) and the one-off seen-set import (`importSeen`), behind the `titan-yt-scout` CLI. Detect, transcribe and score are typed seams only (`Detector`, `Transcriber`, `Scorer`); full-text search over transcripts is `corpus-query`, and the durable step runner is `workflow`.
