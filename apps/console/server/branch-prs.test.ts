import { describe, expect, it } from "vitest";
import type { GhExec } from "@titan-design/github";
import type { GitRunner } from "@titan-design/worktree";
import { branchStateReader, type BranchInput } from "./branch-prs.js";

// Synthetic clones and pull requests; nothing here comes from a real repository.
const ORIGINS: Record<string, string> = { "/synthetic/orbit": "git@github.com:example/orbit.git", "/synthetic/lantern": "https://github.com/example/lantern" };
const LOCAL = new Set(["/synthetic/orbit pc-or-1-retry", "/synthetic/orbit pc-or-2-depth"]);

const git: GitRunner = async (args, cwd) => {
  if (args[0] === "remote") return ORIGINS[cwd] ?? null;
  if (args[0] === "rev-parse") return LOCAL.has(`${cwd} ${args.at(-1)!.slice("refs/heads/".length)}`) ? "0123abcd" : null;
  return null;
};

const pr = (number: number, headRefName: string, state: string, rollup: string[] = []) => ({
  number, headRefName, state, title: `PR ${number}`, url: `https://example.invalid/${number}`, statusCheckRollup: rollup.map((conclusion) => ({ conclusion })),
});

const LISTS: Record<string, unknown[]> = {
  "example/orbit": [pr(44, "pc-or-1-retry", "OPEN", ["SUCCESS", "FAILURE"]), pr(41, "pc-or-1-retry", "CLOSED"), pr(42, "pc-or-2-depth", "MERGED", ["SUCCESS", "SUCCESS"])],
  "example/lantern": [pr(7, "pc-ld-3", "OPEN", ["SUCCESS", ""])],
};

function fakeGh(fail = false) {
  const calls: string[][] = [];
  const gh: GhExec = async (args) => {
    calls.push([...args]);
    if (fail) return { code: 1, stdout: "", stderr: "HTTP 502 from GitHub" };
    return { code: 0, stdout: JSON.stringify(LISTS[args[args.indexOf("--repo") + 1]!] ?? []), stderr: "" };
  };
  return { gh, calls };
}

const BRANCHES: BranchInput[] = [
  { repo: "/synthetic/orbit", name: "pc-or-1-retry", note: "OR-1 retry" },
  { repo: "/synthetic/orbit", name: "pc-or-2-depth" },
  { repo: "/synthetic/lantern", name: "pc-ld-3" },
];

describe("the branch PR reader", () => {
  it("lists each GitHub repository's PRs once, however many branches live in it", async () => {
    const { gh, calls } = fakeGh();
    await branchStateReader({ git, gh })(BRANCHES);
    expect(calls.map((args) => args[args.indexOf("--repo") + 1])).toEqual(["example/orbit", "example/lantern"]);
    expect(calls[0]).toEqual(expect.arrayContaining(["pr", "list", "--state", "all"]));
  });

  it("gives each branch its newest PR by head, with the checks summary, and no absolute path", async () => {
    const { gh } = fakeGh();
    const { branches, degraded } = await branchStateReader({ git, gh })(BRANCHES);
    expect(branches).toEqual([
      { repo: "orbit", name: "pc-or-1-retry", note: "OR-1 retry", present: true, pr: { number: 44, state: "OPEN", title: "PR 44", url: "https://example.invalid/44", checks: "fail (1/2)" } },
      { repo: "orbit", name: "pc-or-2-depth", present: true, pr: expect.objectContaining({ number: 42, state: "MERGED", checks: "pass (2/2)" }) },
      { repo: "lantern", name: "pc-ld-3", present: false, pr: expect.objectContaining({ number: 7, checks: "pending (1/2)" }) },
    ]);
    expect(degraded).toEqual([]);
  });

  it("reuses a repository's list for a minute, then reads it again", async () => {
    const { gh, calls } = fakeGh();
    let clock = 0;
    const read = branchStateReader({ git, gh, now: () => clock });
    await read(BRANCHES.slice(0, 1));
    clock = 59_000;
    await read(BRANCHES.slice(1, 2));
    expect(calls).toHaveLength(1);
    clock = 61_000;
    await read(BRANCHES.slice(0, 1));
    expect(calls).toHaveLength(2);
  });

  it("marks PR state unread, not failing, when GitHub cannot be listed", async () => {
    const { gh } = fakeGh(true);
    const { branches, degraded } = await branchStateReader({ git, gh })(BRANCHES.slice(0, 1));
    expect(branches).toEqual([{ repo: "orbit", name: "pc-or-1-retry", note: "OR-1 retry", present: true, pr: null }]);
    expect(degraded).toEqual(["Pull requests in example/orbit unread: HTTP 502 from GitHub"]);
  });

  it("asks GitHub nothing for a clone with no GitHub origin", async () => {
    const { gh, calls } = fakeGh();
    const { branches, degraded } = await branchStateReader({ git, gh })([{ repo: "/synthetic/offline", name: "pc-or-5" }]);
    expect(calls).toEqual([]);
    expect(branches).toEqual([{ repo: "offline", name: "pc-or-5", present: false, pr: null }]);
    expect(degraded).toEqual(["offline has no GitHub origin"]);
  });
});
