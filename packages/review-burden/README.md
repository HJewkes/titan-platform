# @titan-design/review-burden

Pure review-burden score for a pull request. Facts in, a 0 to 100 score with each part
shown out, plus the one-way door facts and the parser for the author's merge-danger footer.
No git, GitHub, filesystem or clock access: the caller collects the facts.

Tier 0 of the titan-platform DAG. May import only packages in the same tier or
below; the `package-layers` rule in `.codewatch/check.json` enforces this in CI. It uses
`@titan-design/fix-proof`'s `compileGlobs` for every path rule.

```ts
import { burdenScore, doorFacts, effectiveDoor, parseFooter, underDeclared } from "@titan-design/review-burden";

const score = burdenScore({ files, tiers, packageJsons, body });
const computed = doorFacts({ files, changesetBumps, packageJsons, config: { protectedPaths } });
const declared = parseFooter(body).door;
effectiveDoor(declared, computed.door);
underDeclared(declared, computed.door);
```

## The bin

```sh
pnpm review:burden --base origin/main --body-file body.md
REVIEW_BURDEN_BODY="$body" pnpm review:burden --enforce
pnpm review:burden --config review-burden.json
```

It reads `git diff -M --numstat -z <base>...HEAD` (default base `origin/main`) and the same diff
with `--name-status -z` for each file's real status, plus both sides of every changed
`package.json` (the merge base and `HEAD`). `--config <file>` is a JSON object with any of
`protectedPaths`, `storedDataGlobs`, `generatedGlobs`, `testGlobs`, `ignoredGlobs`,
`migrationGlobs` and `apiGlobs`, each replacing its default. It also reads the PR body
from `--body-file` or the `REVIEW_BURDEN_BODY` variable, prints the burden table, then one JSON
line with the score, door facts and parsed footer. It exits 0 by default. With `--enforce` it
exits 1 and prints a remediation message when the footer is missing or the declared door is
`two-way` while the diff is one-way. An unknown argument or a bad config file exits 2.

See `site/reference/review-burden.md` for the formula and the footer format.
