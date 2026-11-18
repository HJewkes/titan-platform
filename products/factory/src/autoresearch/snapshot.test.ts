import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fakeGitHub, githubPort, type GitHubPort, type OpenPrRequest } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { RegisterArgs } from "../shepherd/register-args.js";
import { execDatedGit } from "./integrate.js";
import { remoteDefaultBranch } from "./ratchet.js";
import { assertSnapshotBranch, cutSnapshot, openSnapshotPr, registerSnapshot, snapshotRefs } from "./snapshot.js";

const IDENTITY = ["-c", "user.name=snapshot fixture", "-c", "user.email=fixture@example.invalid"];
const git = (cwd: string, ...args: string[]) => execDatedGit([...IDENTITY, ...args], cwd);
const AT = "2026-10-21T00:00:00Z";
const PREFIX = "autoresearch/fixture";
const RATCHET = `refs/heads/${PREFIX}/run-1`;
const TAG = "refs/tags/ar/fixture/run-1/m1";
const BRANCH = `refs/heads/${PREFIX}-snap/run-1/m1`;

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

async function commit(work: string, path: string, text: string): Promise<string> {
  writeFileSync(join(work, path), text);
  await git(work, "add", "--all");
  await git(work, "commit", "--quiet", "-m", `edit ${path}`);
  return git(work, "rev-parse", "HEAD");
}

/** A bare `origin` with main and a run's ratchet at `kept`, one winner past the pin. */
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ar-snapshot-test-"));
  roots.push(root);
  const [bare, work] = [join(root, "origin.git"), join(root, "work")];
  mkdirSync(work);
  await git(work, "init", "--quiet", "-b", "main");
  const pin = await commit(work, "src.txt", "pin\n");
  await git(root, "clone", "--quiet", "--bare", work, bare);
  await git(work, "remote", "add", "origin", bare);
  const kept = await commit(work, "src.txt", "kept\n");
  await git(work, "push", "--quiet", "origin", `${kept}:${RATCHET}`);
  const cut = { tree: work, sha: kept, ratchetRef: RATCHET, ratchetPrefix: PREFIX, defaultBranch: "main", target: "fixture", runId: "run-1", k: 1, logDir: "ar-log", log: "kept: i-a1 Δ 3σ\n", frozen: ["eval/**"], at: AT };
  return { bare, work, pin, kept, cut };
}

const remoteRefs = (bare: string) => git(bare, "for-each-ref", "--format=%(refname) %(objectname)");
const advance = async (work: string, text: string) => {
  const sha = await commit(work, "src.txt", text);
  await git(work, "push", "--quiet", "origin", `${sha}:${RATCHET}`);
  return sha;
};

describe("cutting a snapshot", () => {
  it("tags the cut sha and pushes a branch one log commit past it, however far the ratchet has moved on", async () => {
    const { bare, work, kept, cut } = await fixture();
    await advance(work, "later 1\n");
    await advance(work, "later 2\n");

    const result = await cutSnapshot(execDatedGit, cut);

    expect(result).toMatchObject({ tag: TAG, branch: BRANCH, sha: kept });
    expect(await git(bare, "rev-parse", TAG)).toBe(kept);
    expect(await git(bare, "rev-parse", BRANCH)).toBe(result.logSha);
    expect(await git(bare, "rev-parse", `${BRANCH}^`)).toBe(kept);
    expect(await git(bare, "diff", "--name-only", kept, BRANCH)).toBe("ar-log/run-1/m1.md");
    expect(await git(bare, "show", `${BRANCH}:ar-log/run-1/m1.md`)).toBe(cut.log.trim());
  });

  it("moves no checkout in the integration tree", async () => {
    const { work, kept, cut } = await fixture();

    await cutSnapshot(execDatedGit, cut);

    expect(await git(work, "rev-parse", "HEAD")).toBe(kept);
    expect(await git(work, "status", "--porcelain")).toBe("");
  });

  it("refuses a sha the remote ratchet does not hold and pushes nothing", async () => {
    const { bare, work, pin, cut } = await fixture();
    await git(work, "checkout", "--quiet", "--detach", pin);
    const stray = await commit(work, "src.txt", "never kept\n");
    const before = await remoteRefs(bare);

    await expect(cutSnapshot(execDatedGit, { ...cut, sha: stray })).rejects.toThrow("[snapshot-sha]");
    expect(await remoteRefs(bare)).toBe(before);
  });

  it("refuses a log directory under a frozen glob, or one that leaves the repo, and pushes nothing", async () => {
    const { bare, cut } = await fixture();
    const before = await remoteRefs(bare);

    await expect(cutSnapshot(execDatedGit, { ...cut, logDir: "eval/logs" })).rejects.toThrow("[snapshot-log-frozen]");
    await expect(cutSnapshot(execDatedGit, { ...cut, logDir: "../ar-log" })).rejects.toThrow("[snapshot-log]");
    expect(await remoteRefs(bare)).toBe(before);
  });
});

describe("snapshot refs are create-only", () => {
  it("succeeds on a retry with the same first start and rebuilds the same log commit", async () => {
    const { bare, cut } = await fixture();

    const first = await cutSnapshot(execDatedGit, cut);
    const again = await cutSnapshot(execDatedGit, cut);

    expect(again).toEqual(first);
    expect(await git(bare, "rev-parse", BRANCH)).toBe(first.logSha);
  });

  it("refuses a second snapshot at the same m<k> and never retargets its tag", async () => {
    const { bare, work, kept, cut } = await fixture();
    const first = await cutSnapshot(execDatedGit, cut);
    const later = await advance(work, "later\n");

    await expect(cutSnapshot(execDatedGit, { ...cut, sha: later })).rejects.toThrow("[snapshot-exists]");
    expect(await git(bare, "rev-parse", TAG)).toBe(kept);
    expect(await git(bare, "rev-parse", BRANCH)).toBe(first.logSha);
  });

  it("refuses a branch already there, even one the log commit would fast-forward, and creates no tag", async () => {
    const { bare, work, kept, cut } = await fixture();
    await git(work, "push", "--quiet", "origin", `${kept}:${BRANCH}`);

    await expect(cutSnapshot(execDatedGit, cut)).rejects.toThrow("[snapshot-exists]");
    expect(await git(bare, "rev-parse", BRANCH)).toBe(kept);
    expect(await git(bare, "tag", "--list")).toBe("");
  });

  it("leaves no orphan tag when the remote refuses the branch", async () => {
    const { bare, cut } = await fixture();
    const hook = join(bare, "hooks", "update");
    writeFileSync(hook, '#!/bin/sh\ncase "$1" in refs/heads/*-snap/*) echo "ruleset: branch refused" >&2; exit 1;; esac\n');
    chmodSync(hook, 0o755);
    const before = await remoteRefs(bare);

    await expect(cutSnapshot(execDatedGit, cut)).rejects.toThrow(/ruleset: branch refused/);
    expect(await remoteRefs(bare)).toBe(before);
  });
});

describe("snapshot branch names", () => {
  it("names the tag under ar/ and the branch beside the ratchet namespace, never inside it", () => {
    expect(snapshotRefs({ ratchetPrefix: PREFIX, target: "fixture", runId: "run-1", k: 2, defaultBranch: "main" })).toEqual({
      tag: "refs/tags/ar/fixture/run-1/m2",
      branch: `refs/heads/${PREFIX}-snap/run-1/m2`,
    });
  });

  it("refuses the ratchet namespace, including the <prefix>/<run>/m<k> form, main and the default branch, each by its own code", async () => {
    const { bare, work } = await fixture();
    await git(work, "push", "--quiet", "origin", "HEAD:refs/heads/trunk");
    await git(bare, "symbolic-ref", "HEAD", "refs/heads/trunk");
    const defaultBranch = await remoteDefaultBranch(execDatedGit, work);

    expect(() => assertSnapshotBranch(`refs/heads/${PREFIX}/run-1/m1`, PREFIX, defaultBranch)).toThrow("[snapshot-ratchet]");
    expect(() => assertSnapshotBranch(RATCHET, PREFIX, defaultBranch)).toThrow("[snapshot-ratchet]");
    expect(() => assertSnapshotBranch("refs/heads/main", PREFIX, defaultBranch)).toThrow("[snapshot-main]");
    expect(() => assertSnapshotBranch("refs/heads/trunk", PREFIX, defaultBranch)).toThrow("[snapshot-default]");
  });

  it.each([
    ["a widening prefix", { ratchetPrefix: "autoresearch//fixture" }, "[snapshot-prefix]"],
    ["m0", { k: 0 }, "[snapshot-ref]"],
    ["a fractional k", { k: 1.5 }, "[snapshot-ref]"],
    ["a run id with a slash", { runId: "run-1/m9" }, "[snapshot-ref]"],
    ["a target with a dot-dot", { target: "fix..ture" }, "[snapshot-ref]"],
    ["a default branch the snapshot would name", { defaultBranch: `${PREFIX}-snap/run-1/m1` }, "[snapshot-default]"],
  ])("refuses %s", (_name, override, code) => {
    expect(() => snapshotRefs({ ratchetPrefix: PREFIX, target: "fixture", runId: "run-1", k: 1, defaultBranch: "main", ...override })).toThrow(code);
  });
});

describe("the snapshot PR and its Shepherd registration", () => {
  it("opens one PR from the snapshot branch however often it is asked", async () => {
    const fake = fakeGitHub({ repo: "fixture-owner/fixture-repo" });
    fake.refs.set(`${PREFIX}-snap/run-1/m1`, "a".repeat(40));
    const port = githubPort(fake.wire);
    const sent: OpenPrRequest[] = [];
    const watched: Pick<GitHubPort, "openPr"> = { openPr: async (repo, request) => (sent.push(request), port.openPr(repo, request)) };
    const request = { repo: "fixture-owner/fixture-repo", branch: BRANCH, base: "main", target: "fixture", phase: "p1", k: 1, body: "kept: i-a1" };

    const first = await openSnapshotPr(watched, request);
    const again = await openSnapshotPr(watched, request);

    expect(again).toEqual(first);
    expect(fake.effects.createPr).toBe(1);
    expect(sent[0]).toEqual({ head: `${PREFIX}-snap/run-1/m1`, base: "main", title: "ar fixture p1-m1", body: "kept: i-a1" });
    expect(await port.getPr("fixture-owner/fixture-repo", first.pr)).toMatchObject({ headRef: `${PREFIX}-snap/run-1/m1`, baseRef: "main" });
  });

  it("registers the PR under the configured seat with the phase and cut as its slice, in register's own argument shape", async () => {
    const requests: unknown[] = [];
    const register = async (request: unknown) => {
      requests.push(request);
      return { runId: "sh-fixture-1", created: requests.length === 1 };
    };

    const result = await registerSnapshot(register, { repo: "fixture-owner/fixture-repo", pr: 7, task: "fixture/FX-1", implementer: "fixture-seat", phase: "p1", k: 1 });

    expect(result).toEqual({ shepherdRunId: "sh-fixture-1" });
    expect(RegisterArgs.parse(requests[0])).toEqual({ repo: "fixture-owner/fixture-repo", pr: 7, task: "fixture/FX-1", implementer: "fixture-seat", slice: "p1-m1" });
  });
});

describe("the snapshot and sync effects never rewrite history", () => {
  const here = dirname(fileURLToPath(import.meta.url));

  it.each(["snapshot.ts", "sync.ts"])("%s passes git no rebase, reset, squash or forcing flag", (file) => {
    const source = readFileSync(join(here, file), "utf-8");

    expect(source).not.toMatch(/["'`](?:rebase|reset|--squash|--force|-f|--mirror|--delete|-d)["'`]/);
    expect(source).not.toMatch(/["'`]\+/);
    expect(source).not.toMatch(/--force-with-lease=\$\{\w+\}:[^`]/);
  });
});
