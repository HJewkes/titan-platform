import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTestRepo, tempDir, withoutInjectedHooksPath, worldTemplate } from "./test-repo.js";

const scratch: string[] = [];

function scratchDir(prefix: string): string {
  const dir = tempDir(prefix);
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A template counting its builds, whose copies are cleaned after the test and whose root the test can reach. */
function countedTemplate() {
  const roots: string[] = [];
  const copy = worldTemplate(({ root, repo }) => {
    roots.push(root);
    return { base: repo.commit("base") };
  });
  return {
    roots,
    copy() {
      const world = copy();
      scratch.push(world.root);
      return world;
    },
  };
}

describe("worldTemplate", () => {
  it("builds once while the template stays as the build left it", () => {
    const { roots, copy } = countedTemplate();

    const first = copy();
    const second = copy();

    expect(roots).toHaveLength(1);
    expect(second.root).not.toBe(first.root);
    expect(second.repo.git(["rev-parse", "HEAD"]).trim()).toBe(second.base);
  });

  it("builds afresh when the template root is gone", () => {
    const { roots, copy } = countedTemplate();
    copy();
    const [templateRoot = ""] = roots;
    fs.rmSync(templateRoot, { recursive: true, force: true });

    const world = copy();

    expect(roots).toHaveLength(2);
    expect(world.repo.git(["rev-parse", "HEAD"]).trim()).toBe(world.base);
  });

  it("builds afresh when the template changed after its build, and copies none of the change", () => {
    const { roots, copy } = countedTemplate();
    copy();
    const [templateRoot = ""] = roots;
    fs.writeFileSync(path.join(templateRoot, "repo", ".git", "objects", "maintenance.lock"), "");

    const world = copy();

    expect(roots).toHaveLength(2);
    expect(fs.existsSync(path.join(world.root, "repo", ".git", "objects", "maintenance.lock"))).toBe(false);
  });
});

describe("a test repository's push", () => {
  it("starts no maintenance in a bare remote made with default config, which would still be changing it afterwards", () => {
    const repo = makeTestRepo(path.join(scratchDir("egress-push-"), "repo"));
    const bare = path.join(path.dirname(repo.dir), "bare");
    const trace = path.join(path.dirname(repo.dir), "trace");
    repo.git(["init", "-q", "--bare", "-b", "main", bare]);
    repo.commit("base");

    repo.git(["push", "-q", bare, "main"], { GIT_TRACE: trace });

    expect(fs.readFileSync(trace, "utf-8")).toContain("receive-pack");
    expect(fs.readFileSync(trace, "utf-8")).not.toContain("maintenance");
  });
});

describe("withoutInjectedHooksPath", () => {
  it("removes a lone hooksPath pair and the count", () => {
    const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/hooks", HOME: "/h" };

    expect(withoutInjectedHooksPath(env)).toEqual({ HOME: "/h" });
  });

  it("keeps other pairs and renumbers them", () => {
    const env = {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "a",
      GIT_CONFIG_KEY_1: "core.hooksPath",
      GIT_CONFIG_VALUE_1: "/hooks",
      GIT_CONFIG_KEY_2: "init.defaultBranch",
      GIT_CONFIG_VALUE_2: "main",
    };

    expect(withoutInjectedHooksPath(env)).toEqual({
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "user.name",
      GIT_CONFIG_VALUE_0: "a",
      GIT_CONFIG_KEY_1: "init.defaultBranch",
      GIT_CONFIG_VALUE_1: "main",
    });
  });

  it("returns an env without git config pairs unchanged", () => {
    expect(withoutInjectedHooksPath({ HOME: "/h" })).toEqual({ HOME: "/h" });
  });
});
