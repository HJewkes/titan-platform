import { fakeGitHub, fakeSha, githubPort } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { parseTarget, readPrFacts } from "./pr-facts.js";

const REPO = "HJewkes/titan-platform";

function prWithFiles() {
  const fake = fakeGitHub({ repo: REPO });
  const pr = fake.addPr({ headSha: fakeSha("head") });
  fake.prFiles.set(pr.number, [
    { path: "src/a.ts", status: "modified", additions: 3, deletions: 1 },
    { path: "src/b.ts", previousPath: "src/old-b.ts", status: "renamed", additions: 0, deletions: 0 },
  ]);
  return { fake, port: githubPort(fake.wire), pr: pr.number };
}

describe("parseTarget", () => {
  it("reads owner/repo#N", () => {
    expect(parseTarget("o/r#12")).toEqual({ repo: "o/r", pr: 12 });
  });

  it.each(["o/r", "o/r#0", "r#1", "o/r#-1", "o/r#1x"])("rejects %s", (text) => {
    expect(() => parseTarget(text)).toThrow(/owner\/repo#N/);
  });
});

describe("readPrFacts", () => {
  it("maps each changed file with its line counts and rename source, at the PR's head", async () => {
    const { port, pr } = prWithFiles();

    const facts = await readPrFacts(port, { repo: REPO, pr });

    expect(facts).toEqual({
      repo: REPO,
      pr,
      head: fakeSha("head"),
      base: "",
      changedFiles: [
        { path: "src/a.ts", additions: 3, deletions: 1 },
        { path: "src/b.ts", previousPath: "src/old-b.ts", additions: 0, deletions: 0 },
      ],
    });
  });

  it("leaves kind out without --kind, so the panel classes the PR strictly", async () => {
    const { port, pr } = prWithFiles();

    const facts = await readPrFacts(port, { repo: REPO, pr });

    expect(facts).not.toHaveProperty("kind");
  });

  it("takes --head over the PR's head and --kind as given, without reading the PR", async () => {
    const { fake, port, pr } = prWithFiles();

    const facts = await readPrFacts(port, { repo: REPO, pr }, { head: fakeSha("pinned"), kind: "docs" });

    expect(facts.head).toBe(fakeSha("pinned"));
    expect(facts.kind).toBe("docs");
    expect(fake.calls).not.toContain("getPr");
  });

  it("rejects a --head that is not a full sha", async () => {
    const { port, pr } = prWithFiles();

    await expect(readPrFacts(port, { repo: REPO, pr }, { head: "abc123" })).rejects.toThrow(/40-character/);
  });

  it("throws when the file list cannot be read in full rather than reviewing an empty list", async () => {
    const { fake, port, pr } = prWithFiles();
    fake.prChangedFiles.set(pr, 5000);

    await expect(readPrFacts(port, { repo: REPO, pr })).rejects.toThrow(/cannot read the changed files/);
  });
});
