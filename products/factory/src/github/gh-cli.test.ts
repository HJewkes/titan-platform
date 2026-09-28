import { describe, expect, it } from "vitest";
import { GhError, ghCliWire, type GhExec, type GhResult } from "./gh-cli.js";
import { fakeSha } from "./fake.js";
import { githubPort } from "./port.js";

const H1 = fakeSha("head1");

interface Call {
  args: readonly string[];
  input?: string;
}

/** Answers each `gh` call by the first matching path fragment; records every argv. */
function scriptedGh(answers: Record<string, GhResult | string>): { exec: GhExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: GhExec = async (args, input) => {
    calls.push({ args, input });
    const key = Object.keys(answers).find((fragment) => args.join(" ").includes(fragment));
    const answer = key === undefined ? "{}" : answers[key]!;
    return typeof answer === "string" ? { code: 0, stdout: answer, stderr: "" } : answer;
  };
  return { exec, calls };
}

const REPO = "octo/demo";
const openPr = JSON.stringify({ number: 7, state: "open", merged: false, merge_commit_sha: "test-merge", draft: false, mergeable_state: "clean", head: { ref: "topic", sha: H1 }, base: { ref: "main" } });

describe("gh api adapter", () => {
  it("passes argv as an array to gh api, and merge sends the approved head as sha", async () => {
    const gh = scriptedGh({ "pulls/7/merge": JSON.stringify({ sha: "m1", merged: true }), "compare/": JSON.stringify({ behind_by: 0 }), "pulls/7": openPr });

    const result = await githubPort(ghCliWire(gh.exec)).merge(REPO, 7, H1, "squash");

    const merge = gh.calls.find((call) => call.args.includes("repos/octo/demo/pulls/7/merge"));
    expect(result).toEqual({ mergeSha: "m1", done: true });
    expect(merge?.args).toEqual(["api", "-X", "PUT", "repos/octo/demo/pulls/7/merge", "-f", `sha=${H1}`, "-f", "merge_method=squash"]);
    expect(gh.calls.every((call) => Array.isArray(call.args) && call.args[0] === "api")).toBe(true);
  });

  it("update-branch sends expected_head_sha", async () => {
    const gh = scriptedGh({ "compare/": JSON.stringify({ behind_by: 2 }), "pulls/7/update-branch": JSON.stringify({ message: "Updating" }), "pulls/7": openPr });

    const result = await githubPort(ghCliWire(gh.exec)).updateBranch(REPO, 7, H1);

    const update = gh.calls.find((call) => call.args.includes("repos/octo/demo/pulls/7/update-branch"));
    expect(result).toEqual({ done: true });
    expect(update?.args).toEqual(["api", "-X", "PUT", "repos/octo/demo/pulls/7/update-branch", "-f", `expected_head_sha=${H1}`]);
  });

  it("reads behind from the compare API and never passes a token", async () => {
    const gh = scriptedGh({ [`compare/main...${H1}`]: JSON.stringify({ behind_by: 3 }), "pulls/7": openPr });

    const pr = await ghCliWire(gh.exec).getPr(REPO, 7);

    expect(pr).toMatchObject({ number: 7, headSha: H1, baseRef: "main", behind: true, mergeableState: "clean" });
    expect(gh.calls.flatMap((call) => call.args).some((arg) => /token|authorization/i.test(arg))).toBe(false);
  });

  it("reads required checks from the branch rules, merging every status-check rule", async () => {
    const rules = [
      { type: "pull_request", parameters: { required_approving_review_count: 0 } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "validate" }, { context: "dag-check" }] } },
    ];
    const gh = scriptedGh({ "rules/branches/main": JSON.stringify(rules) });

    expect(await ghCliWire(gh.exec).getBranchRules(REPO, "main")).toEqual({ contexts: ["dag-check", "validate"], strict: true });
  });

  it("parses paginated check-run lines and takes the Actions run id from the job URL", async () => {
    const line = (id: number, name: string) => JSON.stringify({ id, name, status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", details_url: `https://github.com/octo/demo/actions/runs/55/job/${id}`, html_url: null });
    const gh = scriptedGh({ "check-runs": `${line(1, "validate")}\n${line(2, "dag-check")}\n` });

    const runs = await ghCliWire(gh.exec).listCheckRuns(REPO, H1);

    expect(runs.map((run) => [run.name, run.workflowRunId])).toEqual([["validate", 55], ["dag-check", 55]]);
    expect(gh.calls[0]?.args).toContain("--paginate");
  });

  it("reads a missing ref as null and sends file content base64-encoded on stdin", async () => {
    const notFound = { code: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: "gh: Not Found (HTTP 404)\n" };
    const gh = scriptedGh({ "git/ref/heads/": notFound, "contents/": JSON.stringify({ content: { sha: "blob2" } }) });
    const wire = ghCliWire(gh.exec);

    expect(await wire.getRef(REPO, "factory/doc-1")).toBeNull();
    await wire.putContent(REPO, { path: "docs/a.md", branch: "factory/doc-1", content: "héllo", message: "Edit", expectedBlobSha: "blob1" });

    const put = gh.calls.at(-1)!;
    expect(put.args).toEqual(["api", "-X", "PUT", "repos/octo/demo/contents/docs/a.md", "--input", "-"]);
    expect(JSON.parse(put.input!)).toEqual({ message: "Edit", content: Buffer.from("héllo").toString("base64"), branch: "factory/doc-1", sha: "blob1" });
  });

  it("surfaces any other gh failure as a GhError with its HTTP status", async () => {
    const gh = scriptedGh({ "pulls/7/merge": { code: 1, stdout: "", stderr: "gh: Head branch was modified (HTTP 409)\n" } });

    const failure = ghCliWire(gh.exec).merge(REPO, 7, H1, "squash");

    await expect(failure).rejects.toBeInstanceOf(GhError);
    await expect(failure).rejects.toMatchObject({ status: 409 });
  });
});
