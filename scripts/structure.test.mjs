import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkAgentsMatchesClaude,
  checkLayersMatchTiers,
  checkNoFileDependencies,
  checkNoNpmToken,
  checkNoTestsDirectories,
  checkNoWarnSeverity,
  checkPnpmPin,
  checkProductIsolation,
  checkRootLintCoversWorkspaces,
  checkScaffold,
  checkTurboBuildContract,
  checkZodIsPeer,
} from "./structure-rules.mjs";

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = (name) => join(REPO, "scripts", "fixtures", "structure", name);

// Written at run time: Claude Code loads any CLAUDE.md under a directory it reads, so a checked-in one would be read as instructions.
const tempRoots = [];
afterAll(() => tempRoots.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function tempRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function driftedAgentsRoot() {
  const root = tempRoot("structure-agents-");
  writeFileSync(join(root, "CLAUDE.md"), "# Rules\n\nOne rule.\n");
  writeFileSync(join(root, "AGENTS.md"), "# Rules\n");
  return root;
}

// Built from the scaffold-gap fixture at run time so no second package-shaped tree is checked in.
function driftedScriptRoot() {
  const root = tempRoot("structure-scripts-");
  const pkgDir = join(root, "packages", "a");
  cpSync(join(fixture("scaffold-gap"), "packages", "a"), pkgDir, { recursive: true });
  writeFileSync(join(pkgDir, "tsup.config.ts"), "export default {};\n");
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, typecheck: "echo skipped" } }));
  return root;
}

function uncoveredWorkspaceRoot() {
  const root = tempRoot("structure-lint-");
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n  - "apps/*"\n');
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { lint: 'eslint "packages/*/src/**/*.ts"' } }));
  for (const dir of ["packages/a", "apps/web"]) {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "package.json"), "{}");
  }
  return root;
}

function turboRoot(prefix, turbo, { runsProcess }) {
  const root = tempRoot(prefix);
  writeFileSync(join(root, "turbo.json"), JSON.stringify(turbo));
  if (runsProcess) {
    const pkgDir = join(root, "packages", "a");
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({ name: "@titan-design/a" }));
    writeFileSync(join(pkgDir, "tsup.config.ts"), 'import { execFileSync } from "node:child_process";\n');
  }
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
    rule: "R38 a missing to-side pair is reported",
    check: checkProductIsolation,
    root: () => fixture("product-isolation-to-side"),
    message: "`.codewatch/check.json` lacks rule `product-isolation:products/x->products/z`.",
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
    message: "`a` lacks `tsup.config.ts` from the scaffold. Re-stamp with `pnpm new:package`, or fix the entry.",
  },
  {
    rule: "R43 a script that differs from the template is reported",
    check: checkScaffold,
    root: driftedScriptRoot,
    message: "`a` has `script typecheck` that differs from the scaffold (expected `tsc --noEmit`).",
  },
  {
    rule: "R55 the root lint command reaches every workspace",
    check: checkRootLintCoversWorkspaces,
    root: uncoveredWorkspaceRoot,
    message: "The root `lint` script does not reach `apps/web`. Add `apps/web/src` to it in `package.json`",
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
    rule: "R49 a # inside a run command is not a comment",
    check: checkNoNpmToken,
    root: () => fixture("npm-token-run-hash"),
    message: "`release.yml` names an npm token.",
  },
  {
    rule: "R49 a # inside an inline map value is not a comment",
    check: checkNoNpmToken,
    root: () => fixture("npm-token-inline-map"),
    message: "`release.yml` names an npm token.",
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
    rule: "R54 turbo must not rewrite AGENTS.md",
    check: checkTurboBuildContract,
    root: () => turboRoot("structure-turbo-agents-", {}, { runsProcess: false }),
    message: "`turbo.json` must set `agentGuidance: false`, or turbo rewrites the tracked `AGENTS.md` during `pnpm build` in an agent session.",
  },
  {
    rule: "R54 a build that runs a process is never cached",
    check: checkTurboBuildContract,
    root: () => turboRoot("structure-turbo-git-", { agentGuidance: false }, { runsProcess: true }),
    message: "`packages/a` runs a process in its build config. Add a `turbo.json` that extends `//` and sets `tasks.build.cache` to false.",
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
