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
  it("on basement calls basement-suite directly, never through ssh, and never mentions the Mac", () => {
    const rules = suiteRules(true);

    for (const rule of [rules.fixer, rules.reviewer]) {
      expect(rule).toContain("`timeout 300 pnpm exec vitest run <paths>`");
      expect(rule).toContain("`basement-suite <repo> <branch> --agent <your name> --run <script>`");
      expect(rule).toContain("Exit 75 means busy: retry every 5 minutes.");
      expect(rule).toMatch(/dead:check.*dag:check/);
      expect(rule).toContain("never through ssh");
      expect(rule).not.toContain("ssh basement");
      expect(rule).not.toContain("Mac");
    }
  });

  it("elsewhere keeps the ssh form", () => {
    const rules = suiteRules(false);

    for (const rule of [rules.fixer, rules.reviewer]) {
      expect(rule).toContain("ssh basement basement-suite");
      expect(rule).toContain("Never run a full `pnpm test` on the Mac.");
    }
  });
});
