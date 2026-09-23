import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeBin } from "../test-support/fake-bin.js";
import type { FakeBin } from "../test-support/fake-bin.js";
import { LAYERED, PROJECT, captured, replay, seenArgs } from "../test-support/python-audit.js";
import { NO_IMPORT_LINTER_CONFIG, runImportLinter } from "./import-linter.js";

const INI = "[importlinter]\nroot_package = gone\n\n[importlinter:contract:gone-rule]\nname = Gone rule\ntype = forbidden\n";

describe("runImportLinter", () => {
  let bin: FakeBin;
  let empty: string;

  beforeEach(() => {
    bin = createFakeBin();
    empty = realpathSync(mkdtempSync(join(tmpdir(), "style-checker-importlinter-")));
  });
  afterEach(() => {
    bin.restore();
    rmSync(empty, { recursive: true, force: true });
  });

  it("reports a broken contract from .importlinter under its section id, at the importing module", async () => {
    replay(bin, "lint-imports", { stdout: captured("import-linter.stdout.txt"), exitCode: 1 });

    const result = await runImportLinter({ cwd: PROJECT });

    expect(seenArgs(bin)).toEqual(["--config", join(PROJECT, ".importlinter"), "--no-logo", "--no-cache"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        rule: "import-linter/helpers-leaf",
        file: "pkg/helpers.py",
        line: 1,
        severity: "error",
        message: "pkg.helpers is not allowed to import pkg.core: pkg.helpers -> pkg.core",
      }),
    ]);
  });

  it("reports one diagnostic per chain, following an indirect chain, with pyproject ids or a name slug", async () => {
    replay(bin, "lint-imports", { stdout: captured("import-linter-layered.stdout.txt"), exitCode: 1 });

    const result = await runImportLinter({ cwd: LAYERED });

    expect(result.diagnostics.map((d) => `${d.rule} ${d.file}:${d.line} ${d.message.split(": ")[1]}`)).toEqual([
      "import-linter/leaf-isolated app/leaf.py:1 app.leaf -> app.mid -> app.top",
      "import-linter/app-layers app/leaf.py:1 app.leaf -> app.mid",
      "import-linter/app-layers app/mid.py:3 app.mid -> app.top",
    ]);
  });

  it("falls back to the contract name and line 1 when the importing module has no file", async () => {
    writeFileSync(join(empty, ".importlinter"), INI);
    replay(bin, "lint-imports", {
      stdout: "Broken contracts\n----------------\n\nGone rule\n---------\n\ngone.a is not allowed to import gone.b:\n\n-   gone.a -> gone.b (l.7)\n",
      exitCode: 1,
    });

    const result = await runImportLinter({ cwd: empty });

    expect(result.diagnostics).toEqual([expect.objectContaining({ rule: "import-linter/gone-rule", file: "Gone rule", line: 1 })]);
  });

  it("skips the tool with a warning when the project has no import-linter config", async () => {
    replay(bin, "lint-imports", { exitCode: 0 });

    const result = await runImportLinter({ cwd: empty });

    expect(existsSync(join(bin.dir, "args.txt"))).toBe(false);
    expect(result).toMatchObject({ diagnostics: [], failures: [], warnings: [NO_IMPORT_LINTER_CONFIG] });
  });

  it("warns with the install command instead of throwing when lint-imports is not installed", async () => {
    bin.onPathOnly();

    const result = await runImportLinter({ cwd: PROJECT });

    expect(result.warnings).toEqual(["import-linter not found; install with `pip install import-linter`"]);
  });

  it("reports a broken contract whose chains it cannot read as unreadable output", async () => {
    replay(bin, "lint-imports", { stdout: "Helpers must not import core BROKEN\n", exitCode: 1 });

    const result = await runImportLinter({ cwd: PROJECT });

    expect(result.failures).toEqual([expect.objectContaining({ tool: "import-linter", kind: "unparseable-output" })]);
  });
});
