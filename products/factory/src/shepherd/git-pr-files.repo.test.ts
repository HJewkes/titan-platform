import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, type PrFile } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shepherdEventMigration } from "./events.js";
import { CopyDetectionSkipped, cachedByHead, gitPrFiles, prFilesOf, type PrFilesRead } from "./git-pr-files.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { applyRegistrationHold, g10HoldAt } from "./registration-hold.js";
import { holdSlotsMigration, registrationFactsMigration } from "./store-migrations.js";
import { systemGit, type Git } from "./tree-carry.js";
import { ShepherdStore, holdReviewerMigration, holdSatisfiedMigration, lineageMigration, shepherdMigration, sliceMigration } from "./store.js";

const REPO = "acme/widgets";
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const POLICY_FILE = "products/factory/src/shepherd/registration-hold.ts";
const MIGRATION_FILE = "products/factory/src/shepherd/store-migrations.ts";

let root: string;
let origin: string;
let stateDir: string;
let reads: number;

function git(...args: string[]): string {
  return execFileSync("git", ["-C", origin, ...args], { encoding: "utf8", env: TEST_GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const lines = (count: number, edited?: number): string => Array.from({ length: count }, (_, i) => (i === edited ? `edited ${i}` : `line ${i}`)).join("\n") + "\n";

function write(path: string, text: string): void {
  mkdirSync(dirname(join(origin, path)), { recursive: true });
  writeFileSync(join(origin, path), text);
}

function commitAll(message: string): string {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

/** main with the policy and migration files, a feature branch off it, and main moved on, so only a merge-base diff matches. */
function feature(change: () => void): string {
  write(POLICY_FILE, lines(30));
  write(MIGRATION_FILE, lines(20));
  write("packages/x/src/a.ts", lines(10));
  commitAll("base");
  git("checkout", "-q", "-b", "feature");
  change();
  const head = commitAll("feature");
  git("checkout", "-q", "main");
  write("docs/later.md", lines(500));
  commitAll("main moves on");
  return head;
}

/** GitHub's pull refs for `pr` at `head`: the head itself, and the head merged onto main's tip. */
function openPr(pr: number, head: string): void {
  const tree = git("merge-tree", "--write-tree", "main", head).split("\n")[0]!;
  const merge = git("commit-tree", tree, "-p", "main", "-p", head, "-m", `Merge ${head} into main`);
  git("update-ref", `refs/pull/${pr}/head`, head);
  git("update-ref", `refs/pull/${pr}/merge`, merge);
}

const GROWN: PrFile[] = [
  { path: "packages/x/src/a.ts", status: "modified", additions: 1, deletions: 1 },
  { path: "products/factory/src/shepherd/g10-big.ts", status: "added", additions: 450, deletions: 0 },
];

function growPolicy(): void {
  write("packages/x/src/a.ts", lines(10, 3));
  write("products/factory/src/shepherd/g10-big.ts", lines(450));
}

/** A GitHub that answers PR 1's real file list, for a read that falls back from git. */
function apiAnswering(files: PrFile[]) {
  const api = fakeGitHub({ repo: REPO });
  const { number: pr } = api.addPr({ headSha: fakeSha("api-head") });
  api.prFiles.set(pr, files);
  return { api, port: githubPort(api.wire), pr };
}

const gitRead: PrFilesRead = (target) => ((reads += 1), gitPrFiles(target, { stateDir, remote: () => origin }));

/** Real git with a rename limit of 1, so it skips copy detection and warns as it would on a very large diff. */
const limitedGit: Git = (dir, args, signal) => systemGit(dir, args[0] === "diff" ? ["-c", "diff.renameLimit=1", ...args] : args, signal);

function migratedStore(): ShepherdStore {
  const db = openDatabase(":memory:");
  runMigrations(db, [shepherdMigration(4), lineageMigration(5), sliceMigration(8), holdReviewerMigration(9), holdSatisfiedMigration(11), shepherdEventMigration(16), holdSlotsMigration(19), registrationFactsMigration(24)]);
  return new ShepherdStore(db);
}

const byPath = (files: readonly PrFile[]): PrFile[] => [...files].sort((a, b) => a.path.localeCompare(b.path));

/** Each case's `recorded` list is GitHub's pulls/files answer for the same change, as `listPrFiles` maps it. */
const CASES: { name: string; change: () => void; recorded: PrFile[]; reason: string | undefined }[] = [
  {
    name: "a rename of a policy file away",
    change: () => {
      unlinkSync(join(origin, POLICY_FILE));
      write("products/factory/src/shepherd/hold-classes.ts", lines(30, 5));
    },
    recorded: [{ path: "products/factory/src/shepherd/hold-classes.ts", previousPath: POLICY_FILE, status: "renamed", additions: 1, deletions: 1 }],
    reason: "g10-adversary: policy touch",
  },
  {
    name: "a deleted store migration",
    change: () => unlinkSync(join(origin, MIGRATION_FILE)),
    recorded: [{ path: MIGRATION_FILE, status: "removed", additions: 0, deletions: 20 }],
    reason: undefined,
  },
  { name: "a diff adding a policy file", change: growPolicy, recorded: GROWN, reason: "g10-adversary: policy touch" },
];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "git-pr-files-"));
  origin = join(root, "origin");
  stateDir = join(root, "state");
  reads = 0;
  execFileSync("git", ["init", "-q", "-b", "main", origin], { env: TEST_GIT_ENV });
  git("config", "uploadpack.allowAnySHA1InWant", "true");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("the G10 class from local git", { timeout: 30_000 }, () => {
  it.each(CASES)("equals the class of the recorded GitHub file list for $name", async ({ change, recorded, reason }) => {
    const head = feature(change);
    const { port: apiPort, pr } = apiAnswering(recorded);
    openPr(pr, head);
    const local = fakeGitHub({ repo: REPO });

    const files = await gitPrFiles({ repo: REPO, pr, base: "main", head }, { stateDir, remote: () => origin });
    const viaGit = await g10HoldAt(githubPort(local.wire), { repo: REPO, pr, head, base: "main" }, gitRead);
    const viaApi = await g10HoldAt(apiPort, { repo: REPO, pr });

    expect(byPath(files)).toEqual(byPath(recorded));
    expect(viaGit).toBe(reason);
    expect(viaApi).toBe(reason);
    expect(local.calls).toEqual([]);
  });

  it("classes a registration again at its new head, though the PR number stays", async () => {
    const small = feature(() => write("packages/x/src/a.ts", lines(10, 3)));
    openPr(7, small);
    git("checkout", "-q", "feature");
    write("products/factory/src/shepherd/g10-big.ts", lines(450));
    const grown = commitAll("grow");
    git("checkout", "-q", "main");
    const store = migratedStore();
    const fake = fakeGitHub({ repo: REPO });
    const port = githubPort(fake.wire);
    const read = cachedByHead(gitRead);
    store.register({ repo: REPO, pr: 7, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "feature", headSha: small, base: "main" });

    const first = await applyRegistrationHold(port, store, "run-1", { local: read });
    openPr(7, grown);
    store.update("run-1", { task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, headSha: grown });
    const second = await applyRegistrationHold(port, store, "run-1", { local: read });

    expect(first).toBeUndefined();
    expect(second).toBe("g10-adversary: policy touch");
    expect(reads).toBe(2);
    expect(fake.calls).toEqual([]);
  });
});

describe("a fresh-name copy of a policy file", { timeout: 30_000 }, () => {
  const COPY = "products/factory/src/shepherd/merge-rules.ts";
  const copyThenWire = (): void => {
    write(COPY, lines(30, 5));
    write("packages/x/src/a.ts", lines(10, 3));
  };

  it("holds a copy wired in through a non-policy edit g10-adversary", async () => {
    const head = feature(copyThenWire);
    openPr(1, head);
    const store = migratedStore();
    const fake = fakeGitHub({ repo: REPO });
    store.register({ repo: REPO, pr: 1, runId: "run-1", task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY, kind: "feature", headSha: head, base: "main" });

    const files = await gitPrFiles({ repo: REPO, pr: 1, base: "main", head }, { stateDir, remote: () => origin });
    const reason = await applyRegistrationHold(githubPort(fake.wire), store, "run-1", { local: gitRead });

    expect(files).toContainEqual({ path: COPY, previousPath: POLICY_FILE, status: "copied", additions: 30, deletions: 0 });
    expect(reason).toBe("g10-adversary: policy touch");
    expect(store.byRun("run-1")?.holdReason).toBe("g10-adversary: policy touch");
    expect(fake.calls).toEqual([]);
  });

  it("fails closed when git skips copy detection", async () => {
    const head = feature(copyThenWire);
    const { api, port, pr } = apiAnswering([{ path: COPY, status: "added", additions: 30, deletions: 0 }]);
    openPr(pr, head);
    const limited: PrFilesRead = (target) => gitPrFiles(target, { stateDir, remote: () => origin, git: limitedGit });

    const read = prFilesOf(port, { repo: REPO, pr, head, base: "main" }, limited);
    await expect(read).rejects.toBeInstanceOf(CopyDetectionSkipped);
    const reason = await g10HoldAt(port, { repo: REPO, pr, head, base: "main" }, limited);

    expect(reason).toBe("g10-adversary: changed files unread at registration (CopyDetectionSkipped)");
    expect(api.calls).toEqual([]);
  });
});

describe("a registered head or base that is not the PR's", { timeout: 30_000 }, () => {
  it("still holds a policy PR registered with main's tip as its head", async () => {
    const head = feature(growPolicy);
    const { api, port, pr } = apiAnswering(GROWN);
    openPr(pr, head);
    const forged = git("rev-parse", "main");

    const reason = await g10HoldAt(port, { repo: REPO, pr, head: forged, base: "main" }, gitRead);

    expect(reason).toBe("g10-adversary: policy touch");
    expect(api.calls).toContain("listPrFiles");
  });

  it("still holds a policy PR registered with its own branch as the base", async () => {
    const head = feature(growPolicy);
    const { api, port, pr } = apiAnswering(GROWN);
    openPr(pr, head);

    const reason = await g10HoldAt(port, { repo: REPO, pr, head, base: "feature" }, gitRead);

    expect(reason).toBe("g10-adversary: policy touch");
    expect(api.calls).toContain("listPrFiles");
  });

  it("diffs from GitHub's merge base when the named base branch already holds the head", async () => {
    const head = feature(growPolicy);
    git("checkout", "-q", "feature");
    git("merge", "-q", "--no-edit", "main");
    const merged = git("rev-parse", "HEAD");
    expect(merged).not.toBe(head);
    git("checkout", "-q", "main");
    openPr(1, merged);
    git("update-ref", "refs/heads/holds-head", merged);
    const local = fakeGitHub({ repo: REPO });

    const reason = await g10HoldAt(githubPort(local.wire), { repo: REPO, pr: 1, head: merged, base: "holds-head" }, gitRead);

    expect(reason).toBe("g10-adversary: policy touch");
    expect(local.calls).toEqual([]);
  });

  it("reads GitHub's list when the merge ref is still for an older head", async () => {
    const small = feature(() => write("packages/x/src/a.ts", lines(10, 3)));
    const { api, port, pr } = apiAnswering(GROWN);
    openPr(pr, small);
    git("checkout", "-q", "feature");
    write("products/factory/src/shepherd/g10-big.ts", lines(450));
    const grown = commitAll("grow");
    git("checkout", "-q", "main");
    git("update-ref", `refs/pull/${pr}/head`, grown);

    const reason = await g10HoldAt(port, { repo: REPO, pr, head: grown, base: "main" }, gitRead);

    expect(reason).toBe("g10-adversary: policy touch");
    expect(api.calls).toContain("listPrFiles");
  });

  it("reads an empty diff as unread and holds it adversary", async () => {
    feature(growPolicy);
    git("checkout", "-q", "-b", "empty-pr", "main");
    git("commit", "-q", "--allow-empty", "-m", "changes nothing");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    openPr(1, head);
    const { api, port } = apiAnswering([]);

    const reason = await g10HoldAt(port, { repo: REPO, pr: 1, head, base: "main" }, gitRead);

    expect(reason).toBe("g10-adversary: changed files unread at registration (EmptyPrDiff)");
    expect(api.calls).toEqual([]);
  });
});
