import { fakeSha, type GhExec, type GhResult } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { errorClass } from "./error-class.js";
import { ghForcePushes, pushedAwaySince } from "./force-pushes.js";

const H0 = fakeSha("h0");
const H1 = fakeSha("h1");
const H2 = fakeSha("h2");
const H3 = fakeSha("h3");

function answering(result: GhResult): { exec: GhExec; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  return { exec: async (args) => (calls.push(args), result), calls };
}

const timeline = (nodes: object[], hasNextPage = false): GhResult => ({
  code: 0,
  stdout: JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage }, nodes } } } } }),
  stderr: "",
});

describe("reading a PR's force-pushes through gh", () => {
  it("answers each push's replaced and new head, oldest first, for the PR asked about", async () => {
    const { exec, calls } = answering(timeline([{ beforeCommit: { oid: H2 }, afterCommit: { oid: H3 } }, { beforeCommit: null, afterCommit: { oid: H1 } }]));

    const pushes = await ghForcePushes(exec)("acme/widgets", 7);

    expect(pushes).toEqual([{ before: H2, after: H3 }, { before: null, after: H1 }]);
    expect(calls[0]).toEqual(expect.arrayContaining(["graphql", "owner=acme", "name=widgets", "number=7"]));
  });

  it("throws with the HTTP status when gh fails", async () => {
    const { exec } = answering({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });

    await expect(ghForcePushes(exec)("acme/widgets", 7)).rejects.toMatchObject({ status: 404 });
  });

  it("throws rather than answer a list cut at one page", async () => {
    const { exec } = answering(timeline([], true));

    const error = await ghForcePushes(exec)("acme/widgets", 7).catch((caught: unknown) => caught);

    expect(errorClass(error)).toBe("ForcePushesTruncated");
  });
});

describe("the heads force-pushed away since the reviewed head", () => {
  it("counts the push that removed the reviewed head and every later one", () => {
    expect(pushedAwaySince([{ before: H0, after: H1 }, { before: H1, after: H2 }, { before: H2, after: H3 }], H1)).toEqual([H1, H2]);
  });

  it("skips the push that brought the reviewed head", () => {
    expect(pushedAwaySince([{ before: H0, after: H1 }, { before: H2, after: H3 }], H1)).toEqual([H2]);
  });

  it("counts every push when the reviewed head is in none of them", () => {
    expect(pushedAwaySince([{ before: H0, after: H3 }, { before: null, after: H2 }], H1)).toEqual([H0, null]);
  });
});
