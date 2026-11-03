# test-kit: use this when

<!-- One to three sentences for a reader deciding whether to reuse this or build something new. Feeds CAPABILITIES.md. -->

A test needs a value of an interface type but the code under test reads only a few of its fields: `partialFake<T>({ ... })` builds it without an `as unknown as T` double cast. For a whole fake service with behaviour, use the package's own fake (for example `fakeGitHub()` in `github`).

A test must show an operation is linear or bounded, typically a glob or regex matcher that could backtrack: `linearWork` with `hostileGlobs` and a step meter, or `countCalls` with a cap, asserts counted work, never a time.

A test runs real git against scratch repositories: `@titan-design/test-kit/git` copies a per-file template (`seedRepo`, `seedRepoWithOrigin`), writes multi-commit history in one process (`withHistory`), and runs git without session hooks or host config (`fixtureEnv`, `gitIn`).
