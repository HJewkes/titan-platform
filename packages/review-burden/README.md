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

See `site/reference/review-burden.md` for the formula and the footer format.
