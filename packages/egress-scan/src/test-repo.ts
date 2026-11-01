import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { seedRepo } from "@titan-design/test-kit/git";
import { afterAll } from "vitest";

/** A throwaway git repository for tests, committed to with the machine's git config ignored. */
export interface TestRepo {
  readonly dir: string;
  git(args: readonly string[], env?: Readonly<Record<string, string>>): string;
  write(relPath: string, contents: string): void;
  /** Stages everything, commits, and returns the new sha; `env` overrides the test idents. */
  commit(message: string, env?: Readonly<Record<string, string>>): string;
}

/** Drops injected `GIT_CONFIG_*` pairs that set `core.hooksPath`, renumbering the pairs that remain. */
export function withoutInjectedHooksPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? "", 10);
  if (!Number.isInteger(count) || count < 0) return { ...env };
  const kept: Array<[string | undefined, string | undefined]> = [];
  for (let i = 0; i < count; i++) {
    if (env[`GIT_CONFIG_KEY_${i}`]?.toLowerCase() !== "core.hookspath") {
      kept.push([env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    }
  }
  const result = { ...env };
  for (let i = 0; i < count; i++) {
    delete result[`GIT_CONFIG_KEY_${i}`];
    delete result[`GIT_CONFIG_VALUE_${i}`];
  }
  kept.forEach(([key, value], i) => {
    result[`GIT_CONFIG_KEY_${i}`] = key;
    result[`GIT_CONFIG_VALUE_${i}`] = value;
  });
  if (kept.length > 0) result.GIT_CONFIG_COUNT = String(kept.length);
  else delete result.GIT_CONFIG_COUNT;
  return result;
}

// By default a push ends by detaching `git maintenance run --auto` in the remote, and that process's objects/maintenance
// lock can vanish while a template is being copied: cpSync lists it, then fails with ENOENT naming the copy (TP-4701).
const ISOLATED_ENV = {
  ...withoutInjectedHooksPath(process.env),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: path.join(import.meta.dirname, "test-repo.gitconfig"),
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

export const ZERO_SHA = "0".repeat(40);

/** A home path assembled at runtime, so this repo's own scan never sees it as a literal. */
export function plantedHomePath(): string {
  return ["", "Users", "zq" + "planted", "src"].join("/");
}

export function tempDir(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** An unborn `main` copied from a per-file template, with no sample hooks; each commit stays a real one. */
export function makeTestRepo(dir = tempDir("egress-scan-")): TestRepo {
  seedRepo(dir, {});
  return openTestRepo(dir);
}

function openTestRepo(dir: string): TestRepo {
  const git = (args: readonly string[], env: Readonly<Record<string, string>> = {}): string =>
    execFileSync("git", [...args], { cwd: dir, encoding: "utf-8", env: { ...ISOLATED_ENV, ...env } });
  return {
    dir,
    git,
    write(relPath, contents) {
      fs.mkdirSync(path.dirname(path.join(dir, relPath)), { recursive: true });
      fs.writeFileSync(path.join(dir, relPath), contents);
    },
    commit(message, env = {}) {
      git(["add", "-A"]);
      git(["commit", "-q", "--allow-empty", "-m", message], env);
      return git(["rev-parse", "HEAD"]).trim();
    },
  };
}

/** A repository at `root/repo`, with room beside it under `root` for the bare remotes its setup makes. */
export interface RepoWorld {
  readonly root: string;
  readonly repo: TestRepo;
}

const worldTemplates: string[] = [];

afterAll(() => {
  for (const root of worldTemplates.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Runs `build` once, on the first call, and hands every call a copy of the world it left, re-pointing the copy's
 * remotes at the copy's root. A setup's dozens of git processes then run once per file instead of once per test.
 * A template that lost or changed anything since it was built is built again, so no copy starts from a damaged one.
 */
export function worldTemplate<T extends object>(build: (world: RepoWorld) => T): () => RepoWorld & T {
  let template: Template<T> | undefined;
  return () => {
    if (template === undefined || contentsOf(template.root) !== template.contents) template = buildWorld(build);
    const root = tempDir("egress-world-");
    fs.cpSync(template.root, root, { recursive: true });
    const config = path.join(root, "repo", ".git", "config");
    fs.writeFileSync(config, fs.readFileSync(config, "utf-8").replaceAll(template.root, root));
    return { ...template.value, root, repo: openTestRepo(path.join(root, "repo")) };
  };
}

interface Template<T> {
  readonly root: string;
  readonly value: T;
  /** `contentsOf` the root when the build finished. */
  readonly contents: string;
}

function buildWorld<T>(build: (world: RepoWorld) => T): Template<T> {
  const root = tempDir("egress-world-");
  worldTemplates.push(root);
  const value = build({ root, repo: makeTestRepo(path.join(root, "repo")) });
  return { root, value, contents: contentsOf(root) };
}

/** Every path under `root` with its size and mtime; empty when `root` is gone. */
function contentsOf(root: string): string {
  if (!fs.existsSync(root)) return "";
  const entries = fs.readdirSync(root, { recursive: true, encoding: "utf-8" }).sort();
  return entries
    .map((entry) => {
      const stat = fs.lstatSync(path.join(root, entry), { throwIfNoEntry: false });
      return `${entry} ${stat?.size} ${stat?.mtimeMs}`;
    })
    .join("\n");
}
