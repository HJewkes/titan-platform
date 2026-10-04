import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkAgentsMatchesClaude,
  checkLayersMatchTiers,
  checkNoFileDependencies,
  checkNoNpmToken,
  checkNoTestsDirectories,
  checkNoWarnSeverity,
  checkPnpmPin,
  checkProductIsolation,
  checkScaffold,
  checkZodIsPeer,
} from "./structure-rules.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (name) => join(REPO, "scripts", "fixtures", "structure", name);

// Written at run time: Claude Code loads any CLAUDE.md under a directory it reads, so a checked-in one would be read as instructions.
function driftedAgentsRoot() {
  const root = mkdtempSync(join(tmpdir(), "structure-agents-"));
  writeFileSync(join(root, "CLAUDE.md"), "# Rules\n\nOne rule.\n");
  writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
  return root;
}

const cases = [
  {
    rule: "R34 no relative file: dependency",
    check: checkNoFileDependencies,
    root: () => fixture("file-dependency"),
    message:
      "`@titan-design/a` depends on `locator` by `file:`. Install the published `@titan-design/locator` version from npm.",
  },
  {
    rule: "R38 products never import each other",
    check: checkProductIsolation,
    root: () => fixture("product-isolation"),
    message: "`.codewatch/check.json` lacks rule `product-isolation:apps/y->products/x`.",
  },
  {
    rule: "R41 layers derive from $tiers",
    check: checkLayersMatchTiers,
    root: () => fixture("layers-drift"),
    message: "`layers` differs from `$tiers`. Edit `$tiers` only, or run `pnpm new:package <name> --tier <t>`.",
  },
  {
    rule: "R43 packages match the scaffold",
    check: checkScaffold,
    root: () => fixture("scaffold-gap"),
    message: "`a` lacks `tsup.config.ts` from the scaffold. Re-stamp with `pnpm new:package`, or add the missing entry.",
  },
  {
    rule: "R46 tests live next to source",
    check: checkNoTestsDirectories,
    root: () => fixture("tests-directory"),
    message: "Move `packages/a/src/__tests__/parse.test.ts` next to the source it tests as `parse.test.ts`.",
  },
  {
    rule: "R47 zod is a peer dependency",
    check: checkZodIsPeer,
    root: () => fixture("zod-dependency"),
    message: "`@titan-design/a` lists zod under dependencies. Move it to peerDependencies and devDependencies.",
  },
  {
    rule: "R49 no npm token in workflows",
    check: checkNoNpmToken,
    root: () => fixture("npm-token"),
    message: "`release.yml` names an npm token. Publishing uses the trusted publisher. Remove the secret.",
  },
  {
    rule: "R51 the pnpm pin holds",
    check: checkPnpmPin,
    root: () => fixture("pnpm-pin"),
    message: "The pnpm pin changed. A pnpm major changes how publish does the OIDC exchange.",
  },
  {
    rule: "R53 AGENTS.md copies CLAUDE.md",
    check: checkAgentsMatchesClaude,
    root: driftedAgentsRoot,
    message: "`AGENTS.md` and `CLAUDE.md` differ. Copy `CLAUDE.md` over `AGENTS.md`.",
  },
  {
    rule: "R10 no lint rule at warn severity",
    check: checkNoWarnSeverity,
    root: () => fixture("warn-severity"),
    message: "Rule `no-debugger` is set to warn in `eslint.config.js`. Set it to error or remove it. Warnings are not allowed.",
  },
];

describe.each(cases)("$rule", ({ check, root, message }) => {
  it("holds in this repo", async () => {
    expect(await check(REPO)).toEqual([]);
  });

  it("reports a violating tree with its remediation", async () => {
    const violations = await check(root());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(message);
  });
});
