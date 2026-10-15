import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { forceRerunTriggers } from "./test-affected.mjs";

const run = promisify(execFile);
const vitest = path.resolve(import.meta.dirname, "../node_modules/vitest/vitest.mjs");
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

let parent;
let repo;

function write(file, body) {
  writeFileSync(path.join(repo, file), body);
}

const git = (...args) => execFileSync("git", args, { cwd: repo, env: GIT_ENV, stdio: "pipe" });

/** A committed repo under `dir` with two leaves, each imported by one test, and the root config's triggers. */
function makeRepo(dir = "") {
  // Real paths, because vitest's changed list comes from git and macOS tmpdir sits behind a /var symlink.
  parent = realpathSync(mkdtempSync(path.join(tmpdir(), "test-affected-")));
  mkdirSync(path.join(parent, dir), { recursive: true });
  repo = mkdtempSync(path.join(parent, dir, "repo-"));
  const config = { test: { include: ["**/*.test.mjs"], forceRerunTriggers: forceRerunTriggers(repo) } };
  write("vitest.config.mjs", `export default ${JSON.stringify(config)};\n`);
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  for (const name of ["leaf", "other"]) {
    write(`${name}.mjs`, `export const ${name} = 1;\n`);
    write(`${name}.test.mjs`, `import { it } from "vitest";\nimport { ${name} } from "./${name}.mjs";\nit("reads", () => ${name});\n`);
  }
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "init");
}

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

async function listChanged() {
  const { stdout } = await run(process.execPath, [vitest, "list", "--changed", "HEAD", "--filesOnly", "--config", "vitest.config.mjs"], {
    cwd: repo,
    env: { ...GIT_ENV, CI: "1", NO_COLOR: "1" },
  });
  return stdout.split("\n").filter(Boolean).map((line) => path.basename(line.trim())).sort();
}

// A child process, because vitest does not support running inside one of its own thread workers.
it("selects only a changed leaf's importers", async () => {
  makeRepo();
  write("leaf.mjs", "export const leaf = 2;\n");

  expect(await listChanged()).toEqual(["leaf.test.mjs"]);
}, 30_000);

it.each([
  ["a plain parent", ""],
  ["a dot-directory parent, as in .worktrees/ or ~/.cache", ".dot"],
  ["a parent with glob metacharacters", "p(1)"],
])("selects every test when only the lockfile changed under %s", async (_label, dir) => {
  makeRepo(dir);
  write("pnpm-lock.yaml", "lockfileVersion: '9.1'\n");

  expect(await listChanged()).toEqual(["leaf.test.mjs", "other.test.mjs"]);
}, 30_000);
