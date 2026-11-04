# review-burden

**Tier 0 · primitives.** Depends on [`fix-proof`](/reference/fix-proof) for its glob matcher.

```sh
npm install @titan-design/review-burden
```

## The problem it solves

A reviewer seat had no shared measure of how much a pull request asks of its reviewer, and
no computed answer to "would a revert undo this?". Authors wrote informal blast-radius notes
under different headings, and none stated reversibility. This package adds one pure function
from diff facts to a score, a list of one-way door facts, and a parser for a fixed footer the
author declares. The same input always gives the same score, so a CI job and Shepherd that
collect the same facts print the same number.

## When to reach for it

- Picking a reviewer profile, or showing a reviewer why a PR is heavy: `burdenScore`.
- Deciding whether a PR is a one-way door, or whether its author under-declared one:
  `doorFacts`, `effectiveDoor`, `underDeclared`.
- Reading the author's footer: `parseFooter`.

To decide who may merge, use [`authority`](/reference/authority). To pick a review class
from PR signals, use [`review-panel`](/reference/review-panel).

## Example

Verified against 0.0.0 (unpublished).

```ts
import { burdenScore, doorFacts, effectiveDoor, parseFooter, underDeclared } from "@titan-design/review-burden";

const files = [
  { path: "src/cli/status.ts", status: "modified", additions: 8, deletions: 2 },
  { path: "src/cli/status.test.ts", status: "modified", additions: 20, deletions: 1 },
] as const;

const score = burdenScore({ files, body: prBody });
// score.total is 18 with no footer: size 3, rationale 10, contract 5.

const computed = doorFacts({ files, changesetBumps: ["patch"], config: { protectedPaths: [".github/**"] } });
const declared = parseFooter(prBody).door;
effectiveDoor(declared, computed.door); // the stricter of the two
underDeclared(declared, computed.door); // true: fail the check and name computed.facts
```

## The footer

At the end of the PR body, above the attribution line:

```markdown
---
<!-- merge-danger:v1 -->
**Merge danger**
- Door: two-way
- Blast radius: `packages/ledger` only. No consumer imports the new export yet.
- Rollback: revert this PR.
- Contract: TP-0001 V1-V3 (sha256:0a1b2c3d)
```

The parser reads the block after the last marker. `present` is true only when all four keys
are non-empty and the door is `one-way` or `two-way`. `Contract: none` counts as no contract.

## Door facts

A PR is one-way by fact when a changed path matches `migrationGlobs`, a changeset declares a
`major` bump, a path (or a rename's old path) matches `protectedPaths`, a `package.json`
loses an `exports` subpath, a `bin` name or its `name`, or a file under `storedDataGlobs` is
removed or renamed away. The effective door is the stricter of declared and computed.

## The score

Files are classed test (`*.test.*`, `*.spec.*`, `__tests__/`, `__fixtures__/`, `golden/`),
ignored (lockfiles, `.changeset/`, `*.md`, `generatedGlobs`) or production. P and T are
production and test lines added plus deleted, F production files, D distinct units.

| Part | Points | Max |
|---|---|---:|
| Size | `round(10 * log2(1 + P / 50))` | 30 |
| Spread | `min(10, F - 1) + min(10, 5 * (D - 1))` | 20 |
| Tests | P <= 10: 0. T = 0: 15. T/P < 0.2: 10. T/P < 0.5: 5. Else 0 | 15 |
| Tier | Tier 0: 10. Tier 1: 6. Tier 2: 3. Higher or none: 0 | 10 |
| Public API | 10 when an `apiGlobs` path or `exports`/`bin` changed | 10 |
| Migration | 15 when a migration glob matched | 15 |
| Dependencies | 5 per new runtime key, 2 per new dev key | 10 |
| Rationale | 10 when the footer is not present | 10 |
| Contract | 5 when the footer names no contract | 5 |

The total is capped at 100. `facts` on the result carries every derived input, so a renderer
can print why each part scored what it did.

## What it deliberately does not do

- No I/O. A caller runs `git diff -M --numstat` or reads GitHub's file list, parses the two
  `package.json` sides and the changesets, and passes them in.
- No thresholds or routing. Which score sends a PR to which reviewer is the caller's config.
- No authority import. Protected paths come in as a glob list.

## Gotchas

- Each `config` key replaces its default list; it does not extend it. Spread
  `DEFAULT_BURDEN_CONFIG.ignoredGlobs` yourself to add one entry.
- A root-level file such as `package.json` joins no unit, so it adds to F but not to D.
- Tier comes from production files only: a test-only change to a tier-0 package scores no
  tier points. Named tiers such as `ui` or `product` count as above every numbered tier.
- `status` uses GitHub's vocabulary: map git's `D` to `removed` and `R` to `renamed` with
  `previousPath` set.

## Where it came from

New. Slice B1 of the merge-danger footer and review-burden plan; a CLI bin and Shepherd's
merge guard consume it in later slices.
