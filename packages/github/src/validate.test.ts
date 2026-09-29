import { describe, expect, it } from "vitest";
import { fakeSha } from "./fake.js";
import { ghCliWire, type GhExec } from "./gh-cli.js";
import { githubPort, type GitHubPort, type MergeMethod } from "./port.js";
import { GitHubInputError } from "./validate.js";

const REPO = "octo/demo";
const SHA = fakeSha("head1");

function recordingPort(): { port: GitHubPort; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GhExec = async (args) => (calls.push([...args]), { code: 0, stdout: '{"object":{"sha":"s"}}', stderr: "" });
  return { port: githubPort(ghCliWire(exec)), calls };
}

const put = (overrides: object) => ({ path: "docs/a.md", branch: "topic", content: "x", message: "m", expectedBlobSha: null, ...overrides });

const refusals: [string, string, (port: GitHubPort) => Promise<unknown>][] = [
  ["repo", "traversal in the repo", (port) => port.getPr("a/b/../../user", 1)],
  ["repo", "a dot-dot owner", (port) => port.getPr("../demo", 1)],
  ["repo", "no owner", (port) => port.getPr("demo", 1)],
  ["repo", "a query in the name", (port) => port.getPr("octo/demo?x=1", 1)],
  ["branch", "dot-dot in a branch", (port) => port.getHeadSha(REPO, "topic/../main")],
  ["branch", "a leading dash", (port) => port.ensureBranch(REPO, "-f", SHA)],
  ["branch", "a leading slash", (port) => port.requiredChecks(REPO, "/main")],
  ["branch", "a control character", (port) => port.getHeadSha(REPO, "topic\nx")],
  ["branch", "a fragment", (port) => port.getHeadSha(REPO, "topic#x")],
  ["head", "a query in the head", (port) => port.findPr(REPO, "topic?state=all")],
  ["base", "a bad base", (port) => port.openPr(REPO, { head: "topic", base: "ma..in", title: "t", body: "b" })],
  ["baseSha", "a short base sha", (port) => port.ensureBranch(REPO, "topic", "abc123")],
  ["sha", "an upper-case sha", (port) => port.merge(REPO, 1, SHA.toUpperCase(), "squash")],
  ["sha", "a path in a sha", (port) => port.getCommit(REPO, `${SHA}/../x`)],
  ["expectedHeadSha", "a non-hex expected head", (port) => port.updateBranch(REPO, 1, "head1")],
  ["expectedBlobSha", "a non-hex blob", (port) => port.putFile(REPO, put({ expectedBlobSha: "blob1" }))],
  ["pr", "a zero PR", (port) => port.getPr(REPO, 0)],
  ["pr", "a fractional PR", (port) => port.merge(REPO, 1.5, SHA, "squash")],
  ["pr", "an unsafe PR", (port) => port.getPr(REPO, Number.MAX_SAFE_INTEGER + 1)],
  ["runId", "a negative run id", (port) => port.rerunFailed(REPO, -5)],
  ["path", "traversal in the path", (port) => port.getFile(REPO, "docs/../../../user", "main")],
  ["path", "a leading slash", (port) => port.putFile(REPO, put({ path: "/etc/passwd" }))],
  ["path", "a query in the path", (port) => port.getFile(REPO, "docs/a.md?ref=x", "main")],
  ["ref", "traversal in a ref", (port) => port.getFile(REPO, "docs/a.md", "../main")],
  ["method", "an unknown merge method", (port) => port.merge(REPO, 1, SHA, "force" as MergeMethod)],
];

describe("port input validation", () => {
  it.each(refusals)("refuses %s (%s) before gh runs", async (field, _scenario, call) => {
    const { port, calls } = recordingPort();

    const refused = call(port);

    await expect(refused).rejects.toBeInstanceOf(GitHubInputError);
    await expect(refused).rejects.toMatchObject({ field });
    expect(calls).toEqual([]);
  });

  it("lets well-formed values through to gh", async () => {
    const { port, calls } = recordingPort();

    await port.getHeadSha("my-org/repo.name_2", "factory/doc-12-abcd1234");
    await port.latestCheckRuns(REPO, SHA);

    expect(calls.map((args) => args[1])).toEqual(["repos/my-org/repo.name_2/git/ref/heads/factory/doc-12-abcd1234", "-X"]);
  });
});
