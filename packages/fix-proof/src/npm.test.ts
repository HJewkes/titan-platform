import { afterEach, describe, expect, it } from "vitest";
import { makeRepo, parsed, removeRepos, VITEST } from "./repo.test-helpers.js";
import { run } from "./run.js";

const BUGGY = "export const add = (a, b) => a - b;\n";
const FIXED = "export const add = (a, b) => a + b;\n";

// No vitest is installed in the fixture, so the config names this checkout's and leaves build to the npm default.
const CONFIG = JSON.stringify({ command: `node ${VITEST} run --globals` });

function lockfile(name: string): string {
  return JSON.stringify({ name, version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name, version: "1.0.0" } } });
}

function npmRepo(name: string, scripts: Record<string, string>, config = CONFIG) {
  const manifest = { name, version: "1.0.0", type: "module", scripts };
  return makeRepo({}, undefined, {
    ".github/fix-proof.json": config,
    "package.json": JSON.stringify(manifest),
    "package-lock.json": lockfile(name),
    "src/math.js": BUGGY,
  });
}

// Shaped like agent-chat: a prepare script npm ci runs, and a build whose output the tests import.
function agentChatRepo(config?: string) {
  const repo = npmRepo("agent-chat-shaped", { prepare: "touch .prepared", build: "test -f .prepared && mkdir -p dist && cp src/math.js dist/math.js" }, config);
  const test = 'import { add } from "../dist/math.js";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n';
  return { repo, head: repo.commit({ "src/math.js": FIXED, "src/math.test.js": test }) };
}

afterEach(removeRepos);

describe("fix-proof run on npm-lockfile repos", { timeout: 120_000 }, () => {
  it("installs with npm ci before building, so an agent-chat shaped fix reproduces", async () => {
    const { repo, head } = agentChatRepo();

    const result = parsed(await run({ repo: repo.dir, base: repo.base, head }));

    expect(result).toMatchObject({ verdict: "reproduced" });
    expect(result.tests).toEqual([{ file: "src/math.test.js", name: "adds", class: "reproduces" }]);
  });

  it("reaches the tests of a relay shaped repo that has no build script", async () => {
    const repo = npmRepo("relay-shaped", { test: "vitest run" });
    const test = 'import { add } from "./math.js";\ntest("adds", () => expect(add(1, 2)).toBe(3));\n';
    const head = repo.commit({ "src/math.js": FIXED, "src/math.test.js": test });

    const result = parsed(await run({ repo: repo.dir, base: repo.base, head }));

    expect(result.verdict).toBe("reproduced");
  });

  it("still lets the config's build override the npm default", async () => {
    const { repo, head } = agentChatRepo(JSON.stringify({ command: `node ${VITEST} run --globals`, build: "exit 3" }));

    const result = parsed(await run({ repo: repo.dir, base: repo.base, head }));

    expect(result).toMatchObject({ verdict: "error", error: "base: build failed (exit 3)" });
  });
});
