# @titan-design/fix-proof

## 0.3.0

### Minor Changes

- 63c2836: `classifyReports` now gives `error` instead of `reproduced` when any selected file is missing from the head report or fails to load there, matching the documented rule that ambiguous input never classifies as `reproduced`.

## 0.2.0

### Minor Changes

- f7161c0: `.egress-allow` globs now compile through fix-proof's shared glob compiler, so `docs/{a,b}.md` expands braces instead of matching nothing. The literal-segment guard checks every brace alternative. `AllowEntry.pattern` (a `RegExp`) is replaced by `AllowEntry.matches`. fix-proof exports `expandBraces`.

### Patch Changes

- f7161c0: `expandBraces` rejects a glob longer than 1024 characters or with more than 32 brace groups before expanding, so single-choice brace chains cannot exhaust memory. egress-scan turns any glob compile failure into an `AllowFileError`, and the root `prepare` builds fix-proof before egress-scan.
- f7161c0: `expandBraces` enforces its 256-alternative cap while expanding, so a glob like `{4096 alternatives}{256 alternatives}` is rejected after 257 strings instead of building the whole product first.

## 0.1.0

### Minor Changes

- 1670037: Add `@titan-design/fix-proof`, the pure core of the fix-proof gate: `planFixProof` (name-status diff and base config to tests, carried files, deleted tests and overlay removals; renames keep their identity), `classifyReports` (base and head vitest JSON to per-test classes and a `reproduced`, `unproven`, `vacuous`, `no-tests` or `error` verdict, matching report files exactly) and `formatResultLine`/`parseResultLine` (a strict `fix-proof/v1` line of at most 4 KB).
