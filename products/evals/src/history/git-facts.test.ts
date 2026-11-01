import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureEnv, withHistory } from "@titan-design/test-kit/git";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MainCommit } from "../corpus/git.js";
import { lines, scratchRepo, type ScratchRepo } from "../corpus/test-fixture.js";
import { commitFacts, mergeCommitFor, sizeBand, type CommitFacts, type MirrorGit } from "./git-facts.js";
import { ensureMirror, mirrorDir } from "./mirror.js";

interface Shas {
  init: string;
  other: string;
  pr7Head: string;
  squash7: string;
  pr9Head: string;
  merge9: string;
  pr11Head: string;
}

let root: string;
let origin: ScratchRepo;
let shas: Shas;
let mirror: MirrorGit;

function buildOrigin(repo: ScratchRepo): Shas {
  const pr7Files = { "src/x.ts": lines(15), "src/x.test.ts": lines(10) };
  const [init = "", pr7Head = "", other = "", squash7 = "", pr9Head = ""] = withHistory(repo.dir, [
    { files: { "src/a.ts": lines(3) }, message: "init" },
    { files: pr7Files, message: "work for 7", branch: "pr7", from: "main" },
    { files: { "src/b.ts": lines(4) }, message: "Other change (#5)" },
    { files: pr7Files, message: "Add x (#7)" },
    { files: { "docs/guide.txt": lines(2) }, message: "work for 9", branch: "pr9", from: "main" },
  ]);
  // pr9 branched from main's tip, so its tree is the merge's tree.
  const merge9 = repo.git(["commit-tree", `${pr9Head}^{tree}`, "-p", squash7, "-p", pr9Head, "-m", "Merge pull request #9 from acme/guide"]);
  const [pr11Head = ""] = withHistory(repo.dir, [
    { files: { "src/d.ts": lines(1) }, message: "work for 11", branch: "pr11", from: merge9 },
    { files: { "src/x.ts": lines(16) }, message: "Follow-up for x (#7)", from: merge9 },
    { files: { "src/c.ts": lines(1) }, message: "No pull head (#12)" },
  ]);
  const pulls = { "7/head": pr7Head, "7/merge": pr7Head, "9/head": pr9Head, "11/head": pr11Head };
  const updates = Object.entries(pulls).map(([ref, sha]) => `update refs/pull/${ref} ${sha}\n`);
  execFileSync("git", ["-C", repo.dir, "update-ref", "--stdin"], { input: updates.join(""), env: fixtureEnv() });
  return { init, other, pr7Head, squash7, pr9Head, merge9, pr11Head };
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "history-facts-"));
  origin = scratchRepo(join(root, "origin"));
  shas = buildOrigin(origin);
  mirror = ensureMirror(join(root, "mirrors"), "acme/widgets", { fetch: true, url: origin.dir });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const factsOf = (n: number): CommitFacts => {
  const result = commitFacts(mirror, n);
  if (!("facts" in result)) throw new Error(`PR ${n} missing: ${result.missing}`);
  return result.facts;
};

describe("commitFacts on a squash-merged PR (kills base_sha taken as the merge commit)", () => {
  it("gives base as the merge commit's first parent and start as the merge base with the PR head", () => {
    const facts = factsOf(7);

    expect(facts).toMatchObject({ merge_sha: shas.squash7, base_sha: shas.other, start_sha: shas.init, head_sha: shas.pr7Head });
  });

  it("lists the diff's paths, test paths and stat", () => {
    const facts = factsOf(7);

    expect(facts).toMatchObject({ paths: ["src/x.test.ts", "src/x.ts"], test_paths: ["src/x.test.ts"], has_tests: true, files: 2, additions: 25, deletions: 0, size_band: "s" });
  });
});

describe("commitFacts on a merge-commit PR (kills a squash-only matcher)", () => {
  it("finds the Merge pull request subject and diffs against its first parent only", () => {
    const facts = factsOf(9);

    expect(facts).toMatchObject({ merge_sha: shas.merge9, base_sha: shas.squash7, start_sha: shas.squash7, head_sha: shas.pr9Head });
    expect(facts).toMatchObject({ paths: ["docs/guide.txt"], test_paths: [], has_tests: false, size_band: "xs" });
  });
});

describe("commitFacts reports why a PR has no facts (kills writing a half-filled case)", () => {
  it("names a PR with a pull head but no commit on main as not-on-main", () => {
    expect(commitFacts(mirror, 11)).toEqual({ missing: "not-on-main" });
  });

  it("names a PR on main with no refs/pull head as no-pull-head", () => {
    expect(commitFacts(mirror, 12)).toEqual({ missing: "no-pull-head" });
  });
});

const commit = (sha: string, subject: string): MainCommit => ({ sha, time: 0, subject, body: "" });

describe("mergeCommitFor", () => {
  it("takes the earliest matching commit when a later subject reuses the number (kills picking the newest match)", () => {
    const log = [commit("later", "Follow-up (#7)"), commit("landed", "Add x (#7)"), commit("parent", "init")];

    expect(mergeCommitFor(log, 7)).toEqual({ merge: "landed", base: "parent" });
  });

  it("ignores numbers that only share a prefix (kills an unanchored number match)", () => {
    const log = [commit("m1", "Thing (#70)"), commit("m2", "Merge pull request #90 from acme/x"), commit("root", "init")];

    expect(mergeCommitFor(log, 7)).toBeUndefined();
    expect(mergeCommitFor(log, 9)).toBeUndefined();
  });

  it("ignores a revert whose subject only quotes the number (kills a matcher that drops the end anchor)", () => {
    const log = [commit("revert", 'Revert "Add x (#7)"'), commit("root", "init")];

    expect(mergeCommitFor(log, 7)).toBeUndefined();
  });

  it("returns nothing for a match on the root commit, which has no first parent (kills an undefined base_sha)", () => {
    expect(mergeCommitFor([commit("root", "Initial (#1)")], 1)).toBeUndefined();
  });
});

describe("sizeBand edges at 20/100/400 lines (kills off-by-one band edges)", () => {
  it.each([
    [20, "xs"],
    [21, "s"],
    [100, "s"],
    [101, "m"],
    [400, "m"],
    [401, "l"],
  ] as const)("%i lines is %s", (count, band) => {
    expect(sizeBand(count)).toBe(band);
  });
});

describe("ensureMirror", () => {
  it("fetches branches and pull heads but not other pull refs (kills a broad refs/* refspec)", () => {
    const refs = origin.git(["--git-dir", mirrorDir(join(root, "mirrors"), "acme/widgets"), "for-each-ref", "--format=%(refname)"]).split("\n");

    expect(refs).toEqual(expect.arrayContaining(["refs/heads/main", "refs/pull/7/head", "refs/pull/9/head", "refs/pull/11/head"]));
    expect(refs).not.toContain("refs/pull/7/merge");
  });

  it("picks up a new pull head on a refetch of an existing mirror (kills skipping fetch once the mirror exists)", () => {
    origin.git(["update-ref", "refs/pull/12/head", shas.pr11Head]);

    const refreshed = ensureMirror(join(root, "mirrors"), "acme/widgets", { fetch: true, url: origin.dir });

    expect(refreshed.pullHead(12)).toBe(shas.pr11Head);
  });

  it("refuses a missing mirror without fetch (kills silently creating an empty mirror)", () => {
    expect(() => ensureMirror(join(root, "mirrors"), "acme/absent", { fetch: false })).toThrow(/no mirror/);
  });

  it("refuses a working checkout at the mirror path (kills dropping the bare-repository guard)", () => {
    const checkoutRoot = join(root, "checkouts");
    mkdirSync(join(checkoutRoot, "acme"), { recursive: true });
    scratchRepo(mirrorDir(checkoutRoot, "acme/live"));

    expect(() => ensureMirror(checkoutRoot, "acme/live", { fetch: false })).toThrow(/not a bare mirror/);
  });
});
