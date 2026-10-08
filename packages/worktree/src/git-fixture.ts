import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { fixtureEnv } from "./test-env.js";

/** Files committed by the seed commit, keyed by path relative to the repository root. */
export type SeedFiles = Readonly<Record<string, string>>;

const DEFAULT_SEED: SeedFiles = { "README.md": "seed\n" };

interface Template {
  local: string;
  repo: string;
  origin: string;
}

// A `git init` plus a seed commit and a bare origin costs a dozen processes; a recursive copy costs none.
const templates = new Map<string, Template>();
let templateRoot: string | undefined;

const git = (args: string[], cwd: string): void => {
  execFileSync("git", args, { cwd, stdio: "pipe", env: fixtureEnv() });
};

function rootDir(): string {
  templateRoot ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wt-template-")));
  return templateRoot;
}

/** The directory holding this test file's templates, or undefined before the first seed. */
export function templateDirectory(): string | undefined {
  return templateRoot;
}

/** Deletes every template built so far; the next seed builds them again. */
export function removeTemplates(): void {
  if (templateRoot) fs.rmSync(templateRoot, { recursive: true, force: true });
  templateRoot = undefined;
  templates.clear();
}

// Each test file loads its own copy of this module, and vitest ends worker threads without emitting `exit`.
afterAll(removeTemplates);

function buildTemplate(files: SeedFiles): Template {
  const dir = fs.mkdtempSync(path.join(rootDir(), "t-"));
  const local = path.join(dir, "local");
  const repo = path.join(dir, "repo");
  const origin = path.join(dir, "origin");
  fs.mkdirSync(repo);
  fs.mkdirSync(origin);
  git(["init", "-q", "-b", "main"], repo);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  git(["config", "commit.gpgsign", "false"], repo);
  // Newer git detaches auto-maintenance after a commit; its lock files come and go under .git/objects while cpSync walks it.
  git(["config", "maintenance.auto", "false"], repo);
  git(["config", "gc.auto", "0"], repo);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }
  git(["add", "."], repo);
  git(["commit", "-q", "-m", "seed"], repo);
  fs.cpSync(repo, local, { recursive: true });
  git(["init", "-q", "--bare", "-b", "main"], origin);
  // A push runs the same detached auto-maintenance on the receiving side (receive.autogc).
  git(["config", "receive.autogc", "false"], origin);
  git(["config", "maintenance.auto", "false"], origin);
  git(["config", "gc.auto", "0"], origin);
  git(["remote", "add", "origin", origin], repo);
  git(["push", "-q", "origin", "main"], repo);
  return { local, repo, origin };
}

function templateFor(files: SeedFiles): Template {
  const key = JSON.stringify(Object.entries(files).sort());
  let template = templates.get(key);
  if (!template) {
    template = buildTemplate(files);
    templates.set(key, template);
  }
  return template;
}

/** Fills the empty directory `dir` with a repository on `main` holding one seed commit, and no remote. */
export function seedRepo(dir: string, files: SeedFiles = DEFAULT_SEED): void {
  fs.cpSync(templateFor(files).local, dir, { recursive: true });
}

/** The same, with `origin` (an empty directory) made the bare remote that already holds the seed commit. */
export function seedRepoWithOrigin(dir: string, origin: string, files: SeedFiles = DEFAULT_SEED): void {
  const template = templateFor(files);
  fs.cpSync(template.repo, dir, { recursive: true });
  fs.cpSync(template.origin, origin, { recursive: true });
  const config = path.join(dir, ".git", "config");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(template.origin, origin));
}
