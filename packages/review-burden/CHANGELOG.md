# @titan-design/review-burden

## 0.1.0

### Minor Changes

- 7d10394: Add a `review-burden` bin and a root `review:burden` script. It reads `git diff -M --numstat <base>...HEAD` and a PR body from `--body-file` or `REVIEW_BURDEN_BODY`, prints the burden table and one JSON line, and exits 0. With `--enforce` it exits 1 with a remediation message when the footer is missing or the door is under-declared.
- 9453b27: Add `@titan-design/review-burden`: a pure review-burden score (`burdenScore`) with every part shown, one-way door facts (`doorFacts`, `effectiveDoor`, `underDeclared`), path classes (`classifyPath`) and the `<!-- merge-danger:v1 -->` footer parser (`parseFooter`).
- b9dd008: The `review-burden` bin takes `--config <file>`: a JSON object with any of `protectedPaths`,
  `storedDataGlobs`, `generatedGlobs`, `testGlobs`, `ignoredGlobs`, `migrationGlobs` and `apiGlobs`, each
  replacing its default. An unreadable file, bad JSON, an unknown key or a non-string-array value exits 2. It
  also reads both sides of every changed `package.json`, so `package-key-removed` facts reach the JSON line.

### Patch Changes

- f0736ab: Read `git diff --numstat -z` in the bin, so a changed path with a space or a non-ASCII character keeps its path class instead of arriving quoted.
- 5752afc: The merge-base lookup now pipes stderr like the manifest read, so a failure prints only the skip warning. Adds tests for the renamed-manifest base path and the merge-base failure path.
- 5edd38d: Use the shared `isRecord` and `isObjectLike` from `@titan-design/rpc-protocol/narrow` in place of local copies. Behaviour is unchanged.
- 572fec0: README fixes only: the agent-surface README says when the launcher skips SIGINT and SIGHUP, and the review-burden docs name `git diff -M --numstat -z` as the bin input.
- b9dd008: The `review-burden` bin also reads `git diff -M --name-status -z`, so added, removed, renamed and copied
  files carry their real status. A deleted file under `storedDataGlobs` now yields a `stored-data-deleted` fact.
- Updated dependencies [7492819]
- Updated dependencies [9c70c14]
- Updated dependencies [708e154]
- Updated dependencies [6a2471a]
- Updated dependencies [56d107b]
- Updated dependencies [0848c31]
- Updated dependencies [136b507]
- Updated dependencies [f5d92f3]
- Updated dependencies [7a34209]
- Updated dependencies [bea67f1]
- Updated dependencies [36dc03f]
- Updated dependencies [546c9e2]
- Updated dependencies [31b3632]
- Updated dependencies [661a027]
- Updated dependencies [5edd38d]
- Updated dependencies [4080191]
- Updated dependencies [32637bd]
- Updated dependencies [2451aa9]
- Updated dependencies [d2cce6c]
- Updated dependencies [719f05e]
- Updated dependencies [00f1ab3]
  - @titan-design/fix-proof@0.9.0
  - @titan-design/rpc-protocol@0.4.0
