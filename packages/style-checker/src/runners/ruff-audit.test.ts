import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeBin, heredoc, type FakeBin } from "../test-support/fake-bin.js";
import { runRuffAudit } from "./ruff-audit.js";

function ruffEntry(filename: string): object {
  return {
    code: "C901",
    filename,
    message: "`load` is too complex (14 > 10)",
    location: { row: 12, column: 5 },
    end_location: { row: 12, column: 9 },
    fix: null,
  };
}

describe("runRuffAudit", () => {
  let bin: FakeBin;
  let repo: string;

  beforeEach(() => {
    bin = createFakeBin();
    repo = realpathSync(mkdtempSync(join(tmpdir(), "style-checker-audit-")));
    mkdirSync(join(repo, "pkg"));
  });
  afterEach(() => {
    bin.restore();
    rmSync(repo, { recursive: true, force: true });
  });

  it("reports the ruff code as the rule, a repo-relative file, and the end line", async () => {
    const stdout = JSON.stringify([ruffEntry(join(repo, "pkg/mod.py"))]);
    bin.install("ruff", `cp "$3" "$(dirname "$0")/seen.toml"\n${heredoc(stdout)}\nexit 1`);
    bin.onPathFirst();

    const result = await runRuffAudit(["pkg/mod.py"], { cwd: repo });

    expect(result.failures).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ rule: "C901", file: "pkg/mod.py", line: 12, endLine: 12 }),
    ]);
    const toml = readFileSync(join(bin.dir, "seen.toml"), "utf-8");
    expect(toml.startsWith("preview = true\n[lint]\nselect = [\"C901\", \"PLR0904\"")).toBe(true);
  });
});
