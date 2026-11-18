import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitIn, seedRepo, withHistory } from "@titan-design/test-kit/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hostCarryPorts } from "./carry-cache-adapter.js";
import { cacheMergeUpTree } from "./tree-carry.js";

const REPO = "acme/widgets";

let root: string;
let origin: string;

const git = (...args: string[]): string => gitIn(origin)(...args);
const mergeUpTree = (remote = origin) => cacheMergeUpTree(REPO, { ports: hostCarryPorts, stateDir: join(root, "state"), remote: () => remote });

/** `feature` edits `a.txt` off a shared start; main writes `mainText` to `a.txt`, a conflict, or given "" edits only `b.txt`. */
function forked(mainText: string): { main: string; feature: string } {
  const [, main = "", feature = ""] = withHistory(origin, [
    { files: { "a.txt": "a0\n", "b.txt": "b0\n" }, message: "start" },
    { files: mainText === "" ? { "b.txt": "b1\n" } : { "a.txt": mainText }, message: "main moves" },
    { branch: "feature", from: ":1", files: { "a.txt": "a-feature\n" }, message: "feature edits a.txt" },
  ]);
  return { main, feature };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "merge-up-tree-"));
  origin = join(root, "origin");
  seedRepo(origin, {});
  git("config", "uploadpack.allowAnySHA1InWant", "true");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("cacheMergeUpTree", { timeout: 30_000 }, () => {
  it("answers the tree of the merge update-branch would make of the base commit and the approved head", async () => {
    const { main, feature } = forked("");
    git("merge", "-q", "--no-ff", "--no-edit", "main");

    const tree = await mergeUpTree()(main, feature);

    expect(tree).toBe(git("rev-parse", "HEAD^{tree}"));
  });

  it("answers null when the base commit conflicts with the approved head", async () => {
    const { main, feature } = forked("a-main\n");

    expect(await mergeUpTree()(main, feature)).toBeNull();
  });

  it("throws when the commits cannot be fetched, so no merge-up is proven", async () => {
    const { main, feature } = forked("");

    await expect(mergeUpTree(join(root, "missing"))(main, feature)).rejects.toThrow("git fetch exited");
  });

  it("refuses a name that is not a full sha before running git", async () => {
    const { feature } = forked("");

    await expect(mergeUpTree()("main", feature)).rejects.toThrow();
  });
});
