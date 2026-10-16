import { fakeGitHub, fakeSha, githubPort, type PrFile } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { cachedByHead, parseNameStatus, parseNumstat, prFilesOf, type DiffTarget, type PrFilesRead } from "./git-pr-files.js";

const REPO = "acme/widgets";
const H1 = fakeSha("head-1");
const H2 = fakeSha("head-2");
const LISTED: PrFile[] = [{ path: "from-github.ts", status: "modified", additions: 1, deletions: 0 }];
const LOCAL: PrFile[] = [{ path: "from-git.ts", status: "added", additions: 2, deletions: 0 }];

function counting(answer: () => Promise<PrFile[]> = async () => LOCAL): { read: PrFilesRead; seen: DiffTarget[] } {
  const seen: DiffTarget[] = [];
  return { seen, read: (target) => (seen.push(target), answer()) };
}

function apiWith(files: PrFile[]) {
  const fake = fakeGitHub({ repo: REPO });
  const { number } = fake.addPr({ headSha: H1 });
  fake.prFiles.set(number, files);
  return { fake, port: githubPort(fake.wire), pr: number };
}

describe("reading git's diff output", () => {
  it("names a rename's old and new path, and a delete and an add by their own", () => {
    const raw = ["R087", "old/a.ts", "new/a.ts", "D", "gone.ts", "A", "fresh.ts", "T", "link", ""].join("\0");

    expect(parseNameStatus(raw)).toEqual([
      { status: "renamed", path: "new/a.ts", previousPath: "old/a.ts" },
      { status: "removed", path: "gone.ts" },
      { status: "added", path: "fresh.ts" },
      { status: "changed", path: "link" },
    ]);
  });

  it("names a copy's source and new path, and counts it under the new path", () => {
    const nameStatus = ["C075", "policy/g10-release.ts", "src/rules.ts", ""].join("\0");
    const numstat = ["4\t2\t", "policy/g10-release.ts", "src/rules.ts", ""].join("\0");

    expect(parseNameStatus(nameStatus)).toEqual([{ status: "copied", path: "src/rules.ts", previousPath: "policy/g10-release.ts" }]);
    expect(parseNumstat(numstat)).toEqual(new Map([["src/rules.ts", { additions: 4, deletions: 2 }]]));
  });

  it("counts a rename under its new path and a binary file as zero lines", () => {
    const raw = ["3\t1\t", "old/a.ts", "new/a.ts", "-\t-\timage.png", "0\t20\tgone.ts", ""].join("\0");

    expect(parseNumstat(raw)).toEqual(
      new Map([
        ["new/a.ts", { additions: 3, deletions: 1 }],
        ["image.png", { additions: 0, deletions: 0 }],
        ["gone.ts", { additions: 0, deletions: 20 }],
      ]),
    );
  });
});

describe("the head-keyed file cache", () => {
  it("reads one head once, and a new head of the same PR again", async () => {
    const { read, seen } = counting();
    const cached = cachedByHead(read);

    await cached({ repo: REPO, pr: 1, base: "main", head: H1 });
    await cached({ repo: "ACME/widgets", pr: 1, base: "main", head: H1 });
    await cached({ repo: REPO, pr: 1, base: "main", head: H2 });

    expect(seen.map((target) => target.head)).toEqual([H1, H2]);
  });

  it("asks git again after a failed read", async () => {
    let calls = 0;
    const cached = cachedByHead(async () => (++calls === 1 ? Promise.reject(new Error("fetch refused")) : LOCAL));

    await expect(cached({ repo: REPO, pr: 1, base: "main", head: H1 })).rejects.toThrow("fetch refused");
    expect(await cached({ repo: REPO, pr: 1, base: "main", head: H1 })).toEqual(LOCAL);
  });

  it("forgets the oldest head past its size", async () => {
    const { read, seen } = counting();
    const cached = cachedByHead(read, 1);

    await cached({ repo: REPO, pr: 1, base: "main", head: H1 });
    await cached({ repo: REPO, pr: 1, base: "main", head: H2 });
    await cached({ repo: REPO, pr: 1, base: "main", head: H1 });

    expect(seen).toHaveLength(3);
  });
});

describe("where a PR's files come from", () => {
  it("reads local git and makes no GitHub read when the head and base are known", async () => {
    const { fake, port, pr } = apiWith(LISTED);
    const { read } = counting();

    expect(await prFilesOf(port, { repo: REPO, pr, head: H1, base: "main" }, read)).toEqual(LOCAL);
    expect(fake.calls).toEqual([]);
  });

  it("reads GitHub when the registration names no base", async () => {
    const { port, pr } = apiWith(LISTED);
    const { read, seen } = counting();

    expect(await prFilesOf(port, { repo: REPO, pr, head: H1 }, read)).toEqual(LISTED);
    expect(seen).toEqual([]);
  });

  it("falls back to GitHub when git cannot read the head", async () => {
    const { port, pr } = apiWith(LISTED);
    const { read } = counting(async () => Promise.reject(new Error("not fetchable")));

    expect(await prFilesOf(port, { repo: REPO, pr, head: H1, base: "main" }, read)).toEqual(LISTED);
  });
});
