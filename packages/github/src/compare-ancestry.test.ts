import { describe, expect, it } from "vitest";
import type { GhExec, GhResult } from "./exec.js";
import { fakeGitHub, fakeSha } from "./fake.js";
import { ghCliWire } from "./gh-cli.js";
import { githubPort } from "./port.js";
import { GitHubInputError } from "./validate.js";

const REPO = "o/r";
const A = "a".repeat(40);
const B = "b".repeat(40);

function answering(answer: GhResult): { exec: GhExec; argv: (readonly string[])[] } {
  const argv: (readonly string[])[] = [];
  return { exec: async (args) => (argv.push(args), answer), argv };
}

const ok = (body: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
const portOver = (exec: GhExec) => githubPort(ghCliWire(exec, { sleep: async () => {} }));

describe("compareAncestry over the gh wire", () => {
  it.each(["ahead", "behind", "identical", "diverged"] as const)("answers %s from the compare status", async (status) => {
    const gh = answering(ok({ status, ahead_by: 1, behind_by: 0 }));

    const ancestry = await portOver(gh.exec).compareAncestry(REPO, A, B);

    expect(ancestry).toBe(status);
    expect(gh.argv[0]!.join(" ")).toContain(`repos/o/r/compare/${A}...${B}`);
  });

  it("answers missing when GitHub has not got one of the commits", async () => {
    const gh = answering({ code: 1, stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)\n" });

    await expect(portOver(gh.exec).compareAncestry(REPO, A, B)).resolves.toBe("missing");
  });

  it("throws rather than guess when the status is one it does not know", async () => {
    const gh = answering(ok({ status: "sideways" }));

    await expect(portOver(gh.exec).compareAncestry(REPO, A, B)).rejects.toThrow(/no known ancestry/);
  });

  it("throws on a failure other than 404, so a broken read is never an ancestry", async () => {
    const gh = answering({ code: 1, stdout: "", stderr: "gh: Forbidden (HTTP 403)\n" });

    await expect(portOver(gh.exec).compareAncestry(REPO, A, B)).rejects.toThrow(/403/);
  });

  it("refuses a ref that could escape the compare path before any call", async () => {
    const gh = answering(ok({ status: "ahead" }));

    await expect(portOver(gh.exec).compareAncestry(REPO, "main", "x/../../y")).rejects.toThrow(GitHubInputError);
    expect(gh.argv).toEqual([]);
  });
});

describe("compareAncestry on the fake", () => {
  function history() {
    const fake = fakeGitHub();
    const root = fakeSha("root");
    const left = fakeSha("left");
    const right = fakeSha("right");
    fake.commits.set(left, { sha: left, parents: [root] });
    fake.commits.set(right, { sha: right, parents: [root] });
    return { fake, port: githubPort(fake.wire), root, left, right };
  }

  it("walks the synthetic history for each status", async () => {
    const { port, root, left, right } = history();

    const answers = await Promise.all([port.compareAncestry(REPO, root, left), port.compareAncestry(REPO, left, root), port.compareAncestry(REPO, left, left), port.compareAncestry(REPO, left, right)]);

    expect(answers).toEqual(["ahead", "behind", "identical", "diverged"]);
  });

  it("answers missing for a sha the history never saw, as GitHub's 404 does", async () => {
    const { port, left } = history();

    await expect(port.compareAncestry(REPO, left, fakeSha("never-pushed"))).resolves.toBe("missing");
  });

  it("resolves a branch name to its tip and counts a PR head as known", async () => {
    const { fake, port } = history();
    const head = fakeSha("pr-head");
    fake.addPr({ headSha: head });

    await expect(port.compareAncestry(REPO, "main", head)).resolves.toBe("diverged");
  });

  it("throws a seeded read fault instead of answering", async () => {
    const { fake, port, left, right } = history();
    fake.readFaults.compareAncestry = [new Error("HTTP 502")];

    await expect(port.compareAncestry(REPO, left, right)).rejects.toThrow("HTTP 502");
    await expect(port.compareAncestry(REPO, left, right)).resolves.toBe("diverged");
  });
});
