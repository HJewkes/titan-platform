import { describe, expect, it } from "vitest";
import { forceRerunTriggers, packageDirOf, repoTierDirs, resolveBase, vitestArgs } from "./test-affected.mjs";

const PLAIN = ["run", "--changed", "origin/main", "--passWithNoTests", "--project", "threads", "--project", "forks"];

describe("project selection", () => {
  const repoDirs = repoTierDirs();

  it("leaves the repo tier out for a change in a package with no repo tests", () => {
    expect(vitestArgs("origin/main", ["packages/registry/src/index.ts"], repoDirs)).toEqual(PLAIN);
  });

  it("adds the repo tier for a change in packages/worktree", () => {
    const args = vitestArgs("origin/main", ["README.md", "packages/worktree/src/allocator.ts"], repoDirs);

    expect(args).toEqual([...PLAIN, "--project", "repo"]);
  });

  it("counts the swept egress-scan and factory packages as repo-tier packages", () => {
    expect([...repoDirs]).toEqual(expect.arrayContaining(["packages/egress-scan/", "products/factory/", "packages/worktree/"]));
  });

  it("leaves the repo tier out for a root-only change", () => {
    expect(vitestArgs("origin/main", ["pnpm-lock.yaml", "README.md"], repoDirs)).toEqual(PLAIN);
  });

  it("passes the base through to --changed", () => {
    expect(vitestArgs("HEAD~3", [], repoDirs).slice(0, 3)).toEqual(["run", "--changed", "HEAD~3"]);
  });
});

describe("base", () => {
  it("defaults to origin/main", () => {
    expect(resolveBase({}, [])).toBe("origin/main");
  });

  it("takes the first argument over the default", () => {
    expect(resolveBase({}, ["main"])).toBe("main");
  });

  it("takes TEST_AFFECTED_BASE over the argument", () => {
    expect(resolveBase({ TEST_AFFECTED_BASE: "abc123" }, ["main"])).toBe("abc123");
  });
});

describe("packageDirOf", () => {
  it.each([
    ["packages/worktree/src/park.ts", "packages/worktree/"],
    ["products/factory/src/shepherd/tree-carry.ts", "products/factory/"],
    ["apps/console/src/main.tsx", "apps/console/"],
    ["scripts/test-affected.mjs", "scripts/"],
    ["vitest.config.ts", null],
  ])("maps %s to %s", (path, dir) => {
    expect(packageDirOf(path)).toBe(dir);
  });
});

describe("force-rerun triggers", () => {
  it("anchors every trigger at the root, through dot segments", () => {
    const triggers = forceRerunTriggers("/r/.wt/x");

    expect(triggers.every((trigger) => trigger.startsWith("/r/.wt/x/"))).toBe(true);
  });

  it("escapes glob metacharacters in the root", () => {
    expect(forceRerunTriggers("/r/p(1)")[0]).toBe("/r/p\\(1\\)/**/package.json/**");
  });
});
