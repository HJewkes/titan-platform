import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localBasementSuite, suiteRules } from "./suite-host.js";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function pathWith(file: string, mode: number): string {
  const dir = mkdtempSync(join(tmpdir(), "suite-host-"));
  dirs.push(dir);
  writeFileSync(join(dir, file), "#!/bin/sh\n");
  chmodSync(join(dir, file), mode);
  return dir;
}

describe("localBasementSuite", () => {
  it("is true when an executable basement-suite is on PATH", () => {
    expect(localBasementSuite({ PATH: pathWith("basement-suite", 0o755) }, "mac")).toBe(true);
  });

  it("is true on the host named basement with nothing on PATH", () => {
    expect(localBasementSuite({ PATH: "" }, "basement")).toBe(true);
  });

  it("is false elsewhere, and a non-executable basement-suite does not count", () => {
    expect(localBasementSuite({ PATH: pathWith("basement-suite", 0o644) }, "mac")).toBe(false);
    expect(localBasementSuite({}, "mac.local")).toBe(false);
  });
});

describe("suiteRules", () => {
  it("on basement sends the fixer's full checks to basement-suite directly, never through ssh, and never mentions the Mac", () => {
    const { fixer } = suiteRules(true);

    expect(fixer).toContain("`basement-suite <repo> <branch> --agent <your name> --run <script>`");
    expect(fixer).toContain("Exit 75 means busy: retry every 5 minutes.");
    expect(fixer).toContain("dag:check");
    expect(fixer).toContain("never run dead:check separately");
    expect(fixer).not.toMatch(/dead:check and dag:check|dag:check and dead:check/);
    expect(fixer).toContain("never through ssh");
    expect(fixer).not.toContain("ssh basement");
    expect(fixer).not.toContain("Mac");
  });

  it("on basement still lets a fixer run its affected tests in its own worktree", () => {
    const { fixer } = suiteRules(true);

    expect(fixer).toContain("`pnpm test:affected` where the repo has that script");
    expect(fixer).toContain("`timeout 300 pnpm exec vitest run <paths>`");
    expect(fixer).not.toContain("Never install");
  });

  it("elsewhere names test:affected for the fixer and keeps the ssh form", () => {
    const { fixer } = suiteRules(false);

    expect(fixer).toContain("`pnpm test:affected` where the repo has that script");
    expect(fixer).toContain("ssh basement basement-suite");
    expect(fixer).toContain("Never run a full `pnpm test` on the Mac.");
  });

  it.each([true, false])("tells the reviewer to run no tests and cite the CI check-runs at its head (basement %s)", (onBasement) => {
    const { reviewer } = suiteRules(onBasement);

    expect(reviewer).toContain("Run no tests, builds, typecheck or lint, and install nothing");
    expect(reviewer).toContain("`gh api repos/<repo>/commits/<head>/check-runs");
    expect(reviewer).toContain("Cite each check-run in your review by name and conclusion.");
    expect(reviewer).toContain("A required check that is missing at this head, still running, or red (failure, cancelled or timed_out) is blocking");
    expect(reviewer).not.toMatch(/basement-suite|vitest|ssh basement/);
  });
});
