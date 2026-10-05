import { describe, expect, it } from "vitest";
import type { GhExec, GhResult } from "./exec.js";
import { fakeGitHub, fakeSha } from "./fake.js";
import { FORCE_PUSHES_CAP, ForcePushesTruncated } from "./force-pushes.js";
import { ghCliWire } from "./gh-cli.js";
import { githubPort } from "./port.js";

const REPO = "octo/demo";
const H1 = fakeSha("h1");
const H2 = fakeSha("h2");
const H3 = fakeSha("h3");

function answering(result: GhResult): { exec: GhExec; calls: { args: readonly string[]; input?: string }[] } {
  const calls: { args: readonly string[]; input?: string }[] = [];
  return { exec: async (args, input) => (calls.push({ args, input }), result), calls };
}

const timeline = (nodes: object[], hasNextPage = false): GhResult => ({
  code: 0,
  stdout: JSON.stringify({ data: { repository: { pullRequest: { timelineItems: { pageInfo: { hasNextPage }, nodes } } } } }),
  stderr: "",
});

describe("reading a PR's force-pushes through gh", () => {
  it("answers each push's replaced and new head, oldest first, for the PR asked about", async () => {
    const gh = answering(timeline([{ beforeCommit: { oid: H2 }, afterCommit: { oid: H3 } }, { beforeCommit: null, afterCommit: { oid: H1 } }]));

    const pushes = await githubPort(ghCliWire(gh.exec)).listForcePushes(REPO, 7);

    expect(pushes).toEqual([{ before: H2, after: H3 }, { before: null, after: H1 }]);
    expect(gh.calls[0]!.args.slice(0, 5)).toEqual(["api", "-i", "-X", "POST", "graphql"]);
    expect(JSON.parse(gh.calls[0]!.input!).variables).toEqual({ owner: "octo", name: "demo", number: 7 });
  });

  it("throws with the HTTP status when gh fails", async () => {
    const gh = answering({ code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" });

    await expect(githubPort(ghCliWire(gh.exec)).listForcePushes(REPO, 7)).rejects.toMatchObject({ status: 404 });
  });

  it("throws ForcePushesTruncated rather than answer a list cut at one page", async () => {
    const gh = answering(timeline([], true));

    await expect(githubPort(ghCliWire(gh.exec)).listForcePushes(REPO, 7)).rejects.toMatchObject({ name: "ForcePushesTruncated" });
  });

  it("throws when the PR cannot be resolved", async () => {
    const gh = answering({ code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: null } }, errors: [{ message: "Could not resolve to a PullRequest" }] }), stderr: "" });

    await expect(githubPort(ghCliWire(gh.exec)).listForcePushes(REPO, 7)).rejects.toThrow(/Could not resolve to a PullRequest/);
  });
});

describe("force-pushes on the fake", () => {
  it("answers the seeded pushes, and none for an unseeded PR", async () => {
    const fake = fakeGitHub();
    fake.forcePushes.set(3, [{ before: H1, after: H2 }]);
    const port = githubPort(fake.wire);

    await expect(port.listForcePushes(REPO, 3)).resolves.toEqual([{ before: H1, after: H2 }]);
    await expect(port.listForcePushes(REPO, 4)).resolves.toEqual([]);
  });

  it("throws past the cap, naming it, instead of answering the first page", async () => {
    const fake = fakeGitHub();
    fake.forcePushes.set(3, Array.from({ length: FORCE_PUSHES_CAP + 1 }, (_, i) => ({ before: fakeSha(`b${i}`), after: fakeSha(`a${i}`) })));

    const error = await githubPort(fake.wire).listForcePushes(REPO, 3).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForcePushesTruncated);
    expect((error as Error).message).toContain(`more than ${FORCE_PUSHES_CAP} force-pushes`);
  });

  it("answers exactly the cap as a whole list", async () => {
    const fake = fakeGitHub();
    fake.forcePushes.set(3, Array.from({ length: FORCE_PUSHES_CAP }, (_, i) => ({ before: fakeSha(`b${i}`), after: fakeSha(`a${i}`) })));

    await expect(githubPort(fake.wire).listForcePushes(REPO, 3)).resolves.toHaveLength(FORCE_PUSHES_CAP);
  });
});
