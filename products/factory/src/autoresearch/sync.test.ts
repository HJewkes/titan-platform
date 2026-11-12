import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, githubPort } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { execDatedGit } from "./integrate.js";
import { syncRatchet } from "./sync.js";

const IDENTITY = ["-c", "user.name=sync fixture", "-c", "user.email=fixture@example.invalid"];
const git = (cwd: string, ...args: string[]) => execDatedGit([...IDENTITY, ...args], cwd);
const AT = "2026-10-21T00:00:00Z";
const PREFIX = "autoresearch/fixture";
const RATCHET = `refs/heads/${PREFIX}/run-1`;
const REPO = "fixture-owner/fixture-repo";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

async function commitOn(work: string, from: string, files: Record<string, string>): Promise<string> {
  await git(work, "checkout", "--quiet", "--detach", from);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(work, path, ".."), { recursive: true });
    writeFileSync(join(work, path), text);
  }
  await git(work, "add", "--all");
  await git(work, "commit", "--quiet", "-m", `edit ${Object.keys(files).join(" ")}`);
  return git(work, "rev-parse", "HEAD");
}

const pushTo = (work: string, sha: string, ref: string) => git(work, "push", "--quiet", "origin", `${sha}:${ref}`);

/**
 * The ratchet holds one kept idea; its snapshot PR has merged, as a squash of the idea plus the log, and main may
 * have gained more on top. `onMain` is what lands on main after the squash.
 */
async function fixture(onMain: Record<string, string> = { "other.txt": "unrelated\n" }) {
  const root = mkdtempSync(join(tmpdir(), "ar-sync-test-"));
  roots.push(root);
  const [bare, work] = [join(root, "origin.git"), join(root, "work")];
  mkdirSync(work);
  await git(work, "init", "--quiet", "-b", "main");
  writeFileSync(join(work, "src.txt"), "pin\n");
  await git(work, "add", "--all");
  await git(work, "commit", "--quiet", "-m", "pin");
  const pin = await git(work, "rev-parse", "HEAD");
  await git(root, "clone", "--quiet", "--bare", work, bare);
  await git(work, "remote", "add", "origin", bare);
  const kept = await commitOn(work, pin, { "src.txt": "kept\n" });
  await pushTo(work, kept, RATCHET);
  const squash = await commitOn(work, pin, { "src.txt": "kept\n", "ar-log/run-1/m1.md": "kept: i-a1\n" });
  const main = Object.keys(onMain).length === 0 ? squash : await commitOn(work, squash, onMain);
  await pushTo(work, main, "refs/heads/main");
  const fake = fakeGitHub({ repo: REPO });
  const pr = fake.addPr({ state: "closed", merged: true, headRef: `${PREFIX}-snap/run-1/m1`, headSha: main });
  const input = { repo: REPO, pr: pr.number, tree: work, head: kept, ratchetRef: RATCHET, ratchetPrefix: PREFIX, defaultBranch: "main", frozen: ["eval/**"], logDir: "ar-log", at: AT };
  return { bare, work, kept, main, fake, port: githubPort(fake.wire), input };
}

const remoteRatchet = (bare: string) => git(bare, "rev-parse", RATCHET);
const parentsOf = async (bare: string, sha: string) => (await git(bare, "rev-list", "--parents", "-n", "1", sha)).split(" ").slice(1);

describe("syncing the ratchet after its snapshot PR merges", () => {
  it("merges main in with the old head as first parent, so the next PR diffs only new work", async () => {
    const { bare, work, kept, main, port, input } = await fixture();

    const result = await syncRatchet(execDatedGit, port, input);

    const to = await remoteRatchet(bare);
    expect(result).toEqual({ state: "merged", merged: { from: kept, to, main }, treeChanged: true });
    expect(await parentsOf(bare, to)).toEqual([kept, main]);
    const next = await commitOn(work, to, { "next.txt": "next idea\n" });
    const base = await git(work, "merge-base", "refs/remotes/origin/main", next);
    expect(await git(work, "diff", "--name-only", base, next)).toBe("next.txt");
  });

  it("reports the tree unchanged when main gained only the snapshot log", async () => {
    const { bare, kept, port, input } = await fixture({});

    const result = await syncRatchet(execDatedGit, port, input);

    expect(result).toMatchObject({ state: "merged", treeChanged: false });
    expect(await remoteRatchet(bare)).not.toBe(kept);
  });

  it("returns an open or closed PR's state at once and touches nothing", async () => {
    const { bare, kept, fake, port, input } = await fixture();
    const open = fake.addPr({ headRef: `${PREFIX}-snap/run-1/m2`, headSha: kept });
    const closed = fake.addPr({ state: "closed", headRef: `${PREFIX}-snap/run-1/m3`, headSha: kept });

    expect(await syncRatchet(execDatedGit, port, { ...input, pr: open.number })).toEqual({ state: "open" });
    expect(await syncRatchet(execDatedGit, port, { ...input, pr: closed.number })).toEqual({ state: "closed" });
    expect(await remoteRatchet(bare)).toBe(kept);
  });

  it("parks a restart after the push on the ratchet lease instead of moving the ratchet again", async () => {
    const { bare, port, input } = await fixture();
    await syncRatchet(execDatedGit, port, input);
    const synced = await remoteRatchet(bare);

    await expect(syncRatchet(execDatedGit, port, input)).rejects.toThrow("[ratchet-moved]");
    expect(await remoteRatchet(bare)).toBe(synced);
  });
});

describe("a sync the loop must hold at its gate", () => {
  it("returns a conflict as data, leaving the remote ratchet and the tree as they were", async () => {
    const { bare, kept, port, input } = await fixture({ "src.txt": "main moved the same line\n" });

    const result = await syncRatchet(execDatedGit, port, input);

    expect(result).toEqual({ state: "merged", conflict: ["src.txt"] });
    expect(await remoteRatchet(bare)).toBe(kept);
    expect(await git(input.tree, "status", "--porcelain")).toBe("");
  });

  it("returns main's frozen changes and pushes nothing", async () => {
    const { bare, kept, port, input } = await fixture({ "eval/score.sh": "exit 0\n" });

    const result = await syncRatchet(execDatedGit, port, input);

    expect(result).toEqual({ state: "merged", frozen: ["eval/score.sh"] });
    expect(await remoteRatchet(bare)).toBe(kept);
  });

  it("fast-forwards the ratchet to a resolved commit that holds both the ratchet head and main's tip", async () => {
    const { bare, work, kept, main, port, input } = await fixture({ "src.txt": "main moved the same line\n" });
    await git(work, "checkout", "--quiet", "--detach", kept);
    await git(work, "merge", "--quiet", "--no-ff", "-X", "theirs", "-m", "resolve", main);
    const resolved = await git(work, "rev-parse", "HEAD");

    const result = await syncRatchet(execDatedGit, port, { ...input, resolved });

    expect(result).toEqual({ state: "merged", merged: { from: kept, to: resolved, main }, treeChanged: true });
    expect(await remoteRatchet(bare)).toBe(resolved);
  });

  it("refuses a resolved commit that lacks main's tip, or the ratchet head, and pushes nothing", async () => {
    const { bare, work, kept, main, port, input } = await fixture();
    const onlyRatchet = await commitOn(work, kept, { "fix.txt": "fix\n" });
    const onlyMain = await commitOn(work, main, { "fix.txt": "fix\n" });

    await expect(syncRatchet(execDatedGit, port, { ...input, resolved: onlyRatchet })).rejects.toThrow("[sync-resolved]");
    await expect(syncRatchet(execDatedGit, port, { ...input, resolved: onlyMain })).rejects.toThrow("[sync-resolved]");
    expect(await remoteRatchet(bare)).toBe(kept);
  });
});
