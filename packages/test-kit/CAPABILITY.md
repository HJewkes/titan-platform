# test-kit: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

A test needs a value of an interface type but the code under test reads only a few of its fields: `partialFake<T>({ ... })` builds it without an `as unknown as T` double cast. For a whole fake service with behaviour, use the package's own fake (for example `fakeGitHub()` in `github`).
