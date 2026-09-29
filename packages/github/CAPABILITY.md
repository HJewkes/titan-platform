# github: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

Code must read or change GitHub (refs, files, pull requests, required checks, check runs, merges, reruns) over REST through the caller's `gh` login, with every write safe to repeat after a crash. Use `fakeGitHub()` in tests instead of stubbing `gh`.
