# fix-proof: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

You must decide whether a fix pull request's added or changed tests fail on the merge base and pass at head. It plans the overlay from a `git diff -M --name-status` and the base config, classifies two vitest JSON reports per test into a `reproduced`, `unproven`, `vacuous`, `no-tests` or `error` verdict, and encodes it as a 4 KB `fix-proof/v1` line; it runs nothing itself. To decide who may merge afterwards, use authority.
