import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { checkAreas, loadAreas } from "./areas.mjs";
import { metricsCoverageGaps } from "./metrics-check.mjs";
import {
  checkAgentsMatchesClaude,
  checkLayersMatchTiers,
  checkNoFileDependencies,
  checkNoNpmToken,
  checkNoPython,
  checkNoTestsDirectories,
  checkNoWarnSeverity,
  checkPnpmPin,
  checkProductIsolation,
  checkRootLintCoversWorkspaces,
  checkScaffold,
  checkTurboBuildContract,
  checkWorkspaceImportsDeclared,
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

function undeclaredImportRoot() {
  const root = tempRoot("structure-imports-");
  writeFileSync(join(root, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
  const members = {
    a: { name: "@titan-design/a", devDependencies: { "@titan-design/b": "workspace:^" } },
    b: { name: "@titan-design/b" },
    c: { name: "@titan-design/c" },
  };
  for (const [dir, pkg] of Object.entries(members)) {
    mkdirSync(join(root, "packages", dir, "src"), { recursive: true });
    writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(pkg));
  }
  writeFileSync(join(root, "packages/a/src/x.test.ts"), 'import { b } from "@titan-design/b";\nimport { c } from "@titan-design/c";\n');
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

function pythonRoot(prefix, { files = {}, scripts = { build: "tsup" }, group = "products", name = "explainer" }) {
  const root = tempRoot(prefix);
  const dir = join(root, group, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@titan-design/${name}`, scripts }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
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
    rule: "R58 a member declares every workspace package it imports",
    check: checkWorkspaceImportsDeclared,
    root: undeclaredImportRoot,
    message: "`packages/a/src/x.test.ts` imports `@titan-design/c`, which `@titan-design/a` does not declare.",
  },
  {
    rule: "R59 no Python file in a package or product",
    check: checkNoPython,
    root: () => pythonRoot("structure-py-file-", { files: { "tools/x.py": "print(1)\n" } }),
    message: "`products/explainer/tools/x.py` is Python. Write it in TypeScript",
  },
  {
    rule: "R59 no python, pip or uv invocation in a script",
    check: checkNoPython,
    root: () => pythonRoot("structure-py-script-", { scripts: { build: "tsup", align: "cd tools && uv run align.py" } }),
    message: "`products/explainer` script `align` runs python, pip, uv or another Python runner.",
  },
  {
    rule: "R10 no lint rule at warn severity",
    check: checkNoWarnSeverity,
    root: () => fixture("warn-severity"),
    message: "Rule `no-debugger` is set to warn in `eslint.config.js`. Set it to error or remove it. Warnings are not allowed.",
  },
];

describe("R59 Python sample input is data only under the two named style fixtures", () => {
  it.each(["style-analyzer", "style-checker"])("allows .py under packages/%s/fixtures", (name) => {
    const root = pythonRoot("structure-py-sample-", { group: "packages", name, files: { "fixtures/sample.py": "x = 1\n" } });
    expect(checkNoPython(root)).toEqual([]);
  });

  it("rejects .py under another package's fixtures directory", () => {
    const root = pythonRoot("structure-py-other-fixture-", { files: { "fixtures/sample.py": "x = 1\n" } });
    expect(checkNoPython(root)).toEqual([expect.stringContaining("`products/explainer/fixtures/sample.py` is Python.")]);
  });
});

describe("R59 Python files of every kind", () => {
  it.each([
    ["a .pyw file", "tools/win.pyw", "x = 1\n"],
    ["a .pyi stub", "tools/stub.pyi", "x: int\n"],
    ["pyproject.toml", "pyproject.toml", "[project]\n"],
    ["requirements.txt", "requirements.txt", "requests\n"],
    ["requirements-dev.txt", "tools/requirements-dev.txt", "pytest\n"],
    ["an env python shebang", "bin/run", "#!/usr/bin/env python\nprint(1)\n"],
    ["a /usr/bin/python3 shebang", "bin/run", "#!/usr/bin/python3\nprint(1)\n"],
    ["a python3.12 shebang", "bin/run", "#!/usr/bin/env python3.12\nprint(1)\n"],
  ])("rejects %s", (_kind, path, content) => {
    const root = pythonRoot("structure-py-kind-", { files: { [path]: content } });
    expect(checkNoPython(root)).toEqual([expect.stringContaining(`\`products/explainer/${path}\` is Python.`)]);
  });

  it("rejects a .py file under apps/*", () => {
    const root = pythonRoot("structure-py-app-", { group: "apps", name: "web", files: { "scripts/x.py": "x = 1\n" } });
    expect(checkNoPython(root)).toEqual([expect.stringContaining("`apps/web/scripts/x.py` is Python.")]);
  });

  it("allows an extensionless file with a node shebang", () => {
    const root = pythonRoot("structure-py-node-shebang-", { files: { "bin/run": "#!/usr/bin/env node\n" } });
    expect(checkNoPython(root)).toEqual([]);
  });
});

describe("R59 Python invocations in scripts", () => {
  it.each([
    'sh -c "python x.py"',
    ".venv/bin/python x.py",
    "/usr/bin/python3 x.py",
    "python3.12 x.py",
    "pdm run x",
    "hatch run x",
    "pipenv run x",
    "poetry run x",
    "pip install x",
    "tsup && uv run x",
  ])("rejects script %s", (command) => {
    const root = pythonRoot("structure-py-cmd-", { scripts: { align: command } });
    expect(checkNoPython(root)).toEqual([expect.stringContaining("script `align` runs python")]);
  });

  it.each(["tsup", "vitest run python-fixtures", "node scripts/pipeline.mjs"])("allows script %s", (command) => {
    const root = pythonRoot("structure-py-ok-", { scripts: { build: command } });
    expect(checkNoPython(root)).toEqual([]);
  });
});

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

function areasRoot(prefix, tiers, externalIds) {
  const root = tempRoot(prefix);
  mkdirSync(join(root, ".codewatch"));
  mkdirSync(join(root, "scripts"));
  const rule = { id: "package-layers", type: "layered-deps", $tiers: tiers };
  writeFileSync(join(root, ".codewatch", "check.json"), JSON.stringify({ rules: [rule] }));
  const areas = externalIds.map((id) => ({ id, tier: "product" }));
  writeFileSync(join(root, "scripts", "areas-external.json"), JSON.stringify({ areas }));
  return root;
}

const areaCases = [
  {
    rule: "R56 area ids are unique",
    root: () => areasRoot("structure-areas-dup-", { 0: ["packages/relay"] }, ["relay"]),
    message: "Area id `relay` is used twice.",
  },
  {
    rule: "R56 every $tiers path has an area",
    root: () => areasRoot("structure-areas-missing-", { 0: ["packages/Bad_Name"] }, []),
    message: "`packages/Bad_Name` has no area",
  },
];

// Warns, not fails, until W8 (TP-2101) seeds the first entries; then this becomes a failing rule.
describe("R57 every product area has a metrics entry", () => {
  it("warns for each product area in this repo with no entry, without failing", () => {
    const warn = vi.spyOn(console, "warn");
    const gaps = metricsCoverageGaps(REPO, loadAreas(REPO));
    gaps.forEach((gap) => console.warn(`warning: ${gap}`));
    expect(warn).toHaveBeenCalledTimes(gaps.length);
    warn.mockRestore();
  });

  it("reports a product area with no entry as a warning", () => {
    const root = tempRoot("structure-metrics-");
    const gaps = metricsCoverageGaps(root, [{ id: "relay", tier: "product" }]);
    expect(gaps).toEqual([expect.stringContaining("Product area `relay` has no `metrics/relay.yml`.")]);
  });
});

describe.each(areaCases)("$rule", ({ root, message }) => {
  it("holds in this repo", () => {
    expect(checkAreas(REPO)).toEqual([]);
  });

  it("reports a violating tree with its remediation", () => {
    const violations = checkAreas(root());
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(message);
  });
});
