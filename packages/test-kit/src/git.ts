import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";

/** Files committed by the seed commit, keyed by path relative to the repository root. */
export type SeedFiles = Readonly<Record<string, string>>;

/** One commit `withHistory` writes. A `null` file deletes that path. */
export interface HistoryCommit {
  readonly files: Readonly<Record<string, string | null>>;
  readonly message?: string;
  /** The branch the commit lands on; `main` when left out. */
  readonly branch?: string;
  /**
   * The parent: a branch, `:n` for this history's nth commit (from 1), or a full sha. Left out, a commit follows its
   * branch's last commit, or the branch's tip in the repository, or has no parent when the branch does not exist yet.
   */
  readonly from?: string;
  /** When the commit was made, as `Date.parse` reads it; left out, the pinned date `withHistory` gives its position. */
  readonly date?: string;
  /** The author's name, with the email `<name>@example.com`; left out, the fixture identity authors the commit. */
  readonly author?: string;
}

const NAME = "Test";
const EMAIL = "test@example.com";
// Pinned so the same history gives the same shas in every copy and on every run, one second apart in commit order.
const HISTORY_EPOCH = 1_700_000_000;
const DEFAULT_SEED: SeedFiles = { "README.md": "seed\n" };

// Template repositories skip the per-commit costs a fixture never needs: auto-maintenance and gc after each commit
// or push, fsync of every object, and the sample hooks `git init` copies.
const FAST_CONFIG: Readonly<Record<string, string>> = {
  "core.fsync": "none",
  "gc.auto": "0",
  "maintenance.auto": "false",
  "receive.autogc": "false",
  "commit.gpgsign": "false",
  "user.name": NAME,
  "user.email": EMAIL,
};

/**
 * The environment for fixture git commands: no system or global config, a fixed identity, and none of the
 * `GIT_CONFIG_*` entries a session may inject (such as a `core.hooksPath` whose push hook refuses scratch remotes).
 */
export function fixtureEnv(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_CONFIG_"));
  return {
    ...Object.fromEntries(inherited),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: NAME,
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_COMMITTER_NAME: NAME,
    GIT_COMMITTER_EMAIL: EMAIL,
  };
}

/** Runs git in `cwd` under `fixtureEnv`, returning trimmed stdout; a non-zero exit throws with stderr on the error. */
export function gitIn(cwd: string): (...args: string[]) => string {
  return (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: fixtureEnv(), stdio: ["ignore", "pipe", "pipe"] }).trim();
}

interface Template {
  local: string;
  repo: string;
  origin: string;
}

// A `git init`, a seed commit and a bare origin cost a dozen processes; a recursive copy costs none.
const templates = new Map<string, Template>();
let templateRoot: string | undefined;

function rootDir(): string {
  templateRoot ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "git-template-")));
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

// `git init`'s own template brings sample hooks; this one keeps only an empty hooks directory and info/exclude.
function initTemplate(): string {
  const dir = path.join(rootDir(), "init-template");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.join(dir, "hooks"), { recursive: true });
    fs.mkdirSync(path.join(dir, "info"));
    fs.writeFileSync(path.join(dir, "info", "exclude"), "");
  }
  return dir;
}

function initRepo(dir: string, bare: boolean): void {
  gitIn(path.dirname(dir))("init", "-q", `--template=${initTemplate()}`, ...(bare ? ["--bare"] : []), "-b", "main", dir);
  const git = gitIn(dir);
  for (const [key, value] of Object.entries(FAST_CONFIG)) git("config", key, value);
}

function buildTemplate(files: SeedFiles): Template {
  const dir = fs.mkdtempSync(path.join(rootDir(), "t-"));
  const local = path.join(dir, "local");
  const repo = path.join(dir, "repo");
  const origin = path.join(dir, "origin");
  initRepo(repo, false);
  initRepo(origin, true);
  const git = gitIn(repo);
  const seeded = Object.keys(files).length > 0;
  if (seeded) {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    }
    git("add", ".");
    git("commit", "-q", "-m", "seed");
  }
  fs.cpSync(repo, local, { recursive: true });
  git("remote", "add", "origin", origin);
  if (seeded) git("push", "-q", "origin", "main");
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

/**
 * Fills the empty or missing directory `dir` with a repository on `main` holding one seed commit of `files`, and no
 * remote. Empty `files` leave `main` unborn. Each file builds one template per seed and copies it, so a test may
 * change the copy's config, refs and history freely.
 */
export function seedRepo(dir: string, files: SeedFiles = DEFAULT_SEED): void {
  fs.cpSync(templateFor(files).local, dir, { recursive: true });
}

/** The same, with `origin` (an empty or missing directory) made the bare remote that already holds the seed commit. */
export function seedRepoWithOrigin(dir: string, origin: string, files: SeedFiles = DEFAULT_SEED): void {
  const template = templateFor(files);
  fs.cpSync(template.repo, dir, { recursive: true });
  fs.cpSync(template.origin, origin, { recursive: true });
  const config = path.join(dir, ".git", "config");
  fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace(template.origin, origin));
}

const data = (text: string): string => `data ${Buffer.byteLength(text)}\n${text}\n`;

function commitCommand(commit: HistoryCommit, mark: number, parent: string | undefined): string {
  const fileLines = Object.entries(commit.files).map(([file, content]) => (content === null ? `D ${file}\n` : `M 100644 inline ${file}\n${data(content)}`));
  const when = commit.date === undefined ? HISTORY_EPOCH + mark : Math.floor(Date.parse(commit.date) / 1000);
  return [
    `commit refs/heads/${commit.branch ?? "main"}\n`,
    `mark :${mark}\n`,
    commit.author === undefined ? "" : `author ${commit.author} <${commit.author}@example.com> ${when} +0000\n`,
    `committer ${NAME} <${EMAIL}> ${when} +0000\n`,
    data(`${commit.message ?? `commit ${mark}`}\n`),
    parent === undefined ? "" : `from ${parent}\n`,
    ...fileLines,
    `get-mark :${mark}\n`,
  ].join("");
}

// fast-import resolves a branch of its own stream only by its full ref name, and a repository branch only with `^0`.
function importStream(commits: readonly HistoryCommit[], existing: ReadonlySet<string>): string {
  const started = new Set<string>();
  const parentRef = (name: string): string | undefined =>
    started.has(name) ? `refs/heads/${name}` : existing.has(name) ? `refs/heads/${name}^0` : undefined;
  const commands = commits.map((commit, index) => {
    const branch = commit.branch ?? "main";
    const parent = commit.from === undefined ? (started.has(branch) ? undefined : parentRef(branch)) : (parentRef(commit.from) ?? commit.from);
    started.add(branch);
    return commitCommand(commit, index + 1, parent);
  });
  return `${commands.join("")}done\n`;
}

/**
 * Writes `commits` into the repository at `dir` with one `git fast-import`, then checks out the last commit's branch
 * with its tree. Returns each commit's sha, in order. Commit dates are pinned unless a commit names its own, so a
 * history's shas are the same on every run; files are written as mode 100644.
 */
export function withHistory(dir: string, commits: readonly HistoryCommit[]): string[] {
  const git = gitIn(dir);
  const existing = new Set(git("for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean));
  const input = importStream(commits, existing);
  const marks = execFileSync("git", ["-C", dir, "fast-import", "--quiet", "--force", "--done"], { input, encoding: "utf8", env: fixtureEnv() });
  git("checkout", "-q", "-f", commits.at(-1)?.branch ?? "main");
  return marks.trim().split("\n");
}
