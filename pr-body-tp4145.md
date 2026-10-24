Reduce cognitive complexity of `fakeGitHub` (packages/github/src/fake.ts) by extracting the multi-statement wire handlers into named top-level functions. No API or behaviour change.

- Commit 1 adds characterization tests for the previously untested handlers (`fake-wire.test.ts`); they pass against the old code.
- Commit 2 does the extraction; the same tests plus all 169 factory/console/session-miner test files that use `fakeGitHub` pass.
- Patch changeset included.

Task: TP-4145

🤖 Generated with [Claude Code](https://claude.com/claude-code)
