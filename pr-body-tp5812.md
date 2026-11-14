Moves `transcriptFromPath` from active-work into `@titan-design/session-read`, beside `discoverTranscripts`, and deletes active-work's copy. The delta pass imports it from session-read. The test moved with it.

The old copy and the discovery code agreed, so behaviour is unchanged. The one difference is that `transcriptFromPath` does not set `host` for mirrored roots, and it didn't before either. I left that alone.

The closure of `ci-wait` and `sh-await-verdict` changed, so I added a bump file and regenerated `closure.lock.json` and the API snapshot.
