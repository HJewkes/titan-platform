import { describe, expect, it, vi } from "vitest";
import type { GitHubPort, PullRequest } from "@titan-design/github";
import { readLineage, shipLineageReader } from "./ship-lineage.js";

const PROVEN = "a".repeat(40);
const MAIN = "b".repeat(40);
const binding = { repo: "example/tiles", pr: 1, headSha: PROVEN };

const pull = (fields: Partial<PullRequest> = {}): PullRequest => ({
  number: 1, state: "open", merged: false, mergeSha: null, mergedAt: null, headRef: "topic", headSha: PROVEN, headRepo: "example/tiles",
  baseRef: "main", draft: false, mergeableState: "clean", behind: true, behindBy: 3, autoMerge: false, ...fields,
});

function github(pr: PullRequest | Error, tip: string | null = MAIN) {
  return {
    getPr: vi.fn<GitHubPort["getPr"]>(async () => {
      if (pr instanceof Error) throw pr;
      return pr;
    }),
    getHeadSha: vi.fn<GitHubPort["getHeadSha"]>(async () => tip),
  };
}

describe("a Ship round's lineage", () => {
  it("counts the base commits an open proven head lacks, against the base tip", async () => {
    expect(await readLineage(github(pull()), binding)).toEqual({
      known: true, provenSha: PROVEN, merged: false, mergeSha: null, headSha: PROVEN, baseRef: "main", baseSha: MAIN, behind: 3,
    });
  });

  it("reads a merged PR as merged at its merge sha, with no behind count", async () => {
    const merged = pull({ state: "closed", merged: true, mergeSha: "c".repeat(40), behindBy: 0 });

    expect(await readLineage(github(merged), binding)).toMatchObject({ merged: true, mergeSha: "c".repeat(40), behind: null });
  });

  it("leaves behind unknown once the head moved past the proven sha", async () => {
    const lineage = await readLineage(github(pull({ headSha: "d".repeat(40) })), binding);

    expect(lineage).toMatchObject({ known: true, headSha: "d".repeat(40), behind: null });
  });

  it("is unknown with the reason when GitHub cannot be read or the base has no tip", async () => {
    expect(await readLineage(github(new Error("rate limited")), binding)).toEqual({ known: false, reason: "example/tiles#1 unread: rate limited" });
    expect(await readLineage(github(pull(), null), binding)).toEqual({ known: false, reason: "main has no tip on example/tiles" });
  });

  it("reads GitHub once a minute per binding, however often the round is read", async () => {
    let now = 0;
    const port = github(pull());
    const read = shipLineageReader({ github: port, now: () => now });

    await read(binding);
    await read(binding);
    now = 60_000;
    await read(binding);

    expect(port.getPr).toHaveBeenCalledTimes(2);
  });
});
