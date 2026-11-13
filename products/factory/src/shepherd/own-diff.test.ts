import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitIn, seedRepo } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCarryPorts } from "./carry-cache-adapter.js";
import { ownDiff, ownDiffOn, type OwnDiffResult } from "./own-diff.js";

const REPO = "acme/widgets";
const LOCK = "products/factory/src/registry/closure.lock.json";

let root: string;
let origin: string;
let stateDir: string;

const git = (...args: string[]): string => gitIn(origin)(...args);

function write(file: string, text: string): void {
  mkdirSync(dirname(join(origin, file)), { recursive: true });
  writeFileSync(join(origin, file), text);
  git("add", file);
}

function commit(file: string, text: string): string {
  write(file, text);
  git("commit", "-q", "-m", `edit ${file}`);
  return git("rev-parse", "HEAD");
}

const onBranch = (name: string): void => void git("checkout", "-q", name);

function mergeMain(): string {
  git("merge", "-q", "--no-ff", "--no-edit", "main");
  return git("rev-parse", "HEAD");
}

/** The reviewed head on `feature` edits a.txt; main has since moved on with an unrelated b.txt. */
function reviewedHead(): string {
  commit("a.txt", "a0\n");
  commit(LOCK, "{}\n");
  git("checkout", "-q", "-b", "feature");
  const reviewed = commit("a.txt", "a1\n");
  onBranch("main");
  commit("b.txt", "b1\n");
  onBranch("feature");
  return reviewed;
}

const read = (head: string): Promise<OwnDiffResult> => ownDiff({ repo: REPO, baseRef: "main", head }, { ports: hostCarryPorts, stateDir, remote: () => origin });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "own-diff-"));
  origin = join(root, "origin");
  stateDir = join(root, "state");
  seedRepo(origin, {});
  git("config", "uploadpack.allowAnySHA1InWant", "true");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ownDiff", { timeout: 30_000 }, () => {
  it("a head that only merged main has the reviewed head's own-diff id", async () => {
    const reviewed = reviewedHead();
    const mergedOnly = mergeMain();

    const [before, after] = [await read(reviewed), await read(mergedOnly)];

    expect(before).toHaveProperty("id");
    expect(after).toEqual({ id: (before as { id: string }).id, base: git("rev-parse", "main") });
  });

  it("a merge whose resolution edits a PR file changes the own-diff id", async () => {
    const reviewed = reviewedHead();
    git("merge", "-q", "--no-ff", "--no-commit", "main");
    write("a.txt", "a2\n");
    git("commit", "-q", "--no-edit");

    const [before, after] = [await read(reviewed), await read(git("rev-parse", "HEAD"))];

    expect(after).toHaveProperty("id");
    expect(after).not.toMatchObject({ id: (before as { id: string }).id });
  });

  it("a regenerated closure.lock.json leaves the id unchanged", async () => {
    const reviewed = reviewedHead();
    mergeMain();
    const regenerated = commit(LOCK, '{ "regenerated": true }\n');

    expect(await read(regenerated)).toMatchObject({ id: (await read(reviewed) as { id: string }).id });
  });

  it("an unreadable merge base records unread", async () => {
    reviewedHead();
    git("checkout", "-q", "--orphan", "lonely");
    const unrelated = commit("c.txt", "c1\n");

    expect(await read(unrelated)).toEqual({ unread: "git merge-base exited 1" });
  });

  it("a malformed head records unread without touching git", async () => {
    expect(await ownDiff({ repo: REPO, baseRef: "main", head: "HEAD" }, { ports: hostCarryPorts, stateDir, remote: () => origin })).toEqual({ unread: "invalid own-diff input" });
  });
});

describe("ownDiffOn", () => {
  it("an intent recorded before the step, or without it wired, runs no own-diff step", () => {
    expect([ownDiffOn({ kind: "intent" }), ownDiffOn({ kind: "intent", ownDiff: true })]).toEqual([false, true]);
  });
});
