# github: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

Code must read or change GitHub (refs, files, pull requests, required checks, check runs, job logs, merges, reruns, branch deletes) over REST through the caller's `gh` login, with every write safe to repeat after a crash and polling paced by ETags and a shared rate budget. `mergeReadiness` decides, without I/O, whether a PR may merge at an approved head. Use `fakeGitHub()` in tests instead of stubbing `gh`. `formatSquashMessage` (and the `titan-squash-message` bin) builds a deterministic, trailer- and email-free squash commit message from a PR and its commits.
