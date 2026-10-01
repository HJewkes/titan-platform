import { describe, expect, it } from "vitest";
import { GhError, type GhExec, type GhResult } from "./exec.js";
import { ghCliWire } from "./gh-cli.js";
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

/** What `gh api -i` prints: the status line, headers, a blank line, then the body. */
function included(status: number, headers: Record<string, string>, body: unknown): GhResult {
  const head = [`HTTP/2.0 ${status} X`, ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)].join("\r\n");
  return { code: status < 300 ? 0 : 1, stdout: `${head}\r\n\r\n${body === undefined ? "" : JSON.stringify(body)}`, stderr: status < 300 ? "" : `gh: HTTP ${status}\n` };
}
const openPr = JSON.stringify({ number: 7, state: "open", merged: false, merge_commit_sha: "test-merge", draft: false, mergeable_state: "clean", head: { ref: "topic", sha: H1 }, base: { ref: "main" } });

describe("gh api adapter", () => {
  it("passes argv as an array to gh api, and merge sends the approved head as sha", async () => {
    const gh = scriptedGh({ "pulls/7/merge": JSON.stringify({ sha: "m1", merged: true }), "compare/": JSON.stringify({ behind_by: 0 }), "pulls/7": openPr });

    const result = await githubPort(ghCliWire(gh.exec)).merge(REPO, 7, H1, "squash");

    const merge = gh.calls.find((call) => call.args.includes("repos/octo/demo/pulls/7/merge"));
    expect(result).toEqual({ mergeSha: "m1", done: true });
    expect(merge?.args).toEqual(["api", "-i", "-X", "PUT", "repos/octo/demo/pulls/7/merge", "-f", `sha=${H1}`, "-f", "merge_method=squash"]);
    expect(gh.calls.every((call) => Array.isArray(call.args) && call.args[0] === "api")).toBe(true);
  });

  it("update-branch sends expected_head_sha", async () => {
    const gh = scriptedGh({ "compare/": JSON.stringify({ behind_by: 2 }), "pulls/7/update-branch": JSON.stringify({ message: "Updating" }), "pulls/7": openPr });

    const result = await githubPort(ghCliWire(gh.exec)).updateBranch(REPO, 7, H1);

    const update = gh.calls.find((call) => call.args.includes("repos/octo/demo/pulls/7/update-branch"));
    expect(result).toEqual({ done: true });
    expect(update?.args).toEqual(["api", "-i", "-X", "PUT", "repos/octo/demo/pulls/7/update-branch", "-f", `expected_head_sha=${H1}`]);
  });

  it("reads behind from the compare API and never passes a token", async () => {
    const gh = scriptedGh({ [`compare/main...${H1}`]: JSON.stringify({ behind_by: 3 }), "pulls/7": openPr });

    const pr = await ghCliWire(gh.exec).getPr(REPO, 7);

    expect(pr).toMatchObject({ number: 7, headSha: H1, baseRef: "main", behind: true, mergeableState: "clean" });
    expect(gh.calls.flatMap((call) => call.args).some((arg) => /token|authorization/i.test(arg))).toBe(false);
  });

  it("reads a commit's parents and committer date, and leaves the date out when GitHub omits it", async () => {
    const dated = scriptedGh({ [`git/commits/${H1}`]: JSON.stringify({ sha: H1, parents: [{ sha: "p1" }], committer: { date: "2026-02-03T04:05:06Z" } }) });
    const undated = scriptedGh({ [`git/commits/${H1}`]: JSON.stringify({ sha: H1, parents: [] }) });

    const withDate = await ghCliWire(dated.exec).getCommit(REPO, H1);
    const withoutDate = await ghCliWire(undated.exec).getCommit(REPO, H1);

    expect(withDate).toEqual({ sha: H1, parents: ["p1"], committedAt: "2026-02-03T04:05:06Z" });
    expect(withoutDate).toEqual({ sha: H1, parents: [] });
  });

  it("reads required checks from the branch rules, merging every status-check rule", async () => {
    const rules = [
      { type: "pull_request", parameters: { required_approving_review_count: 0 } },
      { type: "required_status_checks", parameters: { strict_required_status_checks_policy: true, required_status_checks: [{ context: "validate" }, { context: "dag-check" }] } },
    ];
    const gh = scriptedGh({ "rules/branches/main": JSON.stringify(rules) });

    expect(await ghCliWire(gh.exec).getBranchRules(REPO, "main")).toEqual({ contexts: ["dag-check", "validate"], strict: true });
  });

  it("reads the bypass of every ruleset behind a pull_request rule, and is true when each is bypassable", async () => {
    const rules = [{ type: "pull_request", ruleset_id: 11 }, { type: "pull_request", ruleset_id: 11 }, { type: "required_status_checks", ruleset_id: 12 }];
    const gh = scriptedGh({ "rules/branches/main": JSON.stringify(rules), "rulesets/11": JSON.stringify({ current_user_can_bypass: "pull_requests_only" }) });

    expect(await ghCliWire(gh.exec).reviewRulesBypassable(REPO, "main")).toBe(true);
    expect(gh.calls.filter((call) => call.args.some((arg) => arg.includes("rulesets/")))).toHaveLength(1);
  });

  it("is false when any ruleset behind a pull_request rule says never", async () => {
    const rules = [{ type: "pull_request", ruleset_id: 11 }, { type: "pull_request", ruleset_id: 12 }];
    const gh = scriptedGh({ "rules/branches/main": JSON.stringify(rules), "rulesets/11": JSON.stringify({ current_user_can_bypass: "always" }), "rulesets/12": JSON.stringify({ current_user_can_bypass: "never" }) });

    expect(await ghCliWire(gh.exec).reviewRulesBypassable(REPO, "main")).toBe(false);
  });

  it("is true when no pull_request rule applies", async () => {
    const gh = scriptedGh({ "rules/branches/main": JSON.stringify([{ type: "required_status_checks", ruleset_id: 12 }]) });

    expect(await ghCliWire(gh.exec).reviewRulesBypassable(REPO, "main")).toBe(true);
  });

  it("follows the next-page link for check runs and reads the run id from the job URL, the app id and the head sha", async () => {
    const run = (id: number, name: string, app: number) => ({ id, name, status: "completed", conclusion: "success", started_at: "2026-01-01T00:00:00Z", head_sha: H1, details_url: `https://github.com/octo/demo/actions/runs/55/job/${id}`, html_url: null, app: { id: app } });
    const next = { link: '<https://api.github.com/repositories/9/commits/x/check-runs?per_page=100&page=2>; rel="next"' };
    const gh = scriptedGh({
      "page=2": included(200, {}, { check_runs: [run(2, "dag-check", 999)] }),
      "check-runs": included(200, next, { check_runs: [run(1, "validate", 15368)] }),
    });

    const runs = await ghCliWire(gh.exec).listCheckRuns(REPO, H1);

    expect(runs.map((one) => [one.name, one.workflowRunId, one.appId, one.headSha])).toEqual([["validate", 55, 15368, H1], ["dag-check", 55, 999, H1]]);
    expect(gh.calls[1]?.args).toEqual(["api", "-i", "-X", "GET", "repositories/9/commits/x/check-runs?per_page=100&page=2"]);
  });

  it("reads a missing ref as null and sends file content base64-encoded on stdin", async () => {
    const notFound = { code: 1, stdout: '{"message":"Not Found","status":"404"}', stderr: "gh: Not Found (HTTP 404)\n" };
    const gh = scriptedGh({ "git/ref/heads/": notFound, "contents/": JSON.stringify({ content: { sha: "blob2" } }) });
    const wire = ghCliWire(gh.exec);

    expect(await wire.getRef(REPO, "factory/doc-1")).toBeNull();
    await wire.putContent(REPO, { path: "docs/a.md", branch: "factory/doc-1", content: "héllo", message: "Edit", expectedBlobSha: "blob1" });

    const put = gh.calls.at(-1)!;
    expect(put.args).toEqual(["api", "-i", "-X", "PUT", "repos/octo/demo/contents/docs/a.md", "--input", "-"]);
    expect(JSON.parse(put.input!)).toEqual({ message: "Edit", content: Buffer.from("héllo").toString("base64"), branch: "factory/doc-1", sha: "blob1" });
  });

  it("surfaces any other gh failure as a GhError with its HTTP status", async () => {
    const gh = scriptedGh({ "pulls/7/merge": { code: 1, stdout: "", stderr: "gh: Head branch was modified (HTTP 409)\n" } });

    const failure = ghCliWire(gh.exec).merge(REPO, 7, H1, "squash");

    await expect(failure).rejects.toBeInstanceOf(GhError);
    await expect(failure).rejects.toMatchObject({ status: 409 });
  });
});

const H2 = fakeSha("head2");
const pull = { number: 7, changed_files: 0, state: "open", merged: false, merge_commit_sha: null, draft: false, mergeable_state: "clean", head: { ref: "topic", sha: H1, repo: { full_name: REPO } }, base: { ref: "main" } };

/** Answers by the REST path in argv, the element after `-X <method>`. */
const ROUTES: [RegExp, unknown][] = [
  [/pulls\/7\/merge$/, { sha: "m1" }],
  [/pulls\/7\/update-branch$/, {}],
  [/pulls\/7$/, pull],
  [/pulls$/, [pull]],
  [/compare\//, { behind_by: 1, merge_base_commit: { sha: H2 }, files: [] }],
  [/issues\/7\/comments$/, []],
  [/^user$/, { login: "octo" }],
  [/pulls\/7\/files$/, []],
  [/git\/ref\/heads\//, { object: { sha: H1 } }],
  [/git\/refs/, undefined],
  [/contents\//, { path: "docs/a.md", sha: "blob1", content: Buffer.from("x").toString("base64"), encoding: "base64" }],
  [/rules\/branches\//, []],
  [/check-runs$/, { check_runs: [] }],
  [/git\/commits\//, { sha: H1, parents: [] }],
  [/actions\/runs\/\d+$/, { status: "completed" }],
  [/rerun-failed-jobs$/, undefined],
  [/actions\/jobs\/\d+\/logs$/, "line 1\nline 2\nline 3\n"],
  [/^repos\/octo\/demo$/, { default_branch: "main" }],
];

function routedGh(): { exec: GhExec; argv: (readonly string[])[] } {
  const argv: (readonly string[])[] = [];
  const exec: GhExec = async (args) => {
    argv.push(args);
    const route = ROUTES.find(([pattern]) => pattern.test(args[4] ?? ""));
    if (!route) return { code: 1, stdout: "", stderr: `no route for ${args.join(" ")} (HTTP 404)` };
    const body = typeof route[1] === "string" ? route[1] : route[1] === undefined ? "" : JSON.stringify(route[1]);
    return { code: 0, stdout: body, stderr: "" };
  };
  return { exec, argv };
}

describe("gh api adapter, REST only", () => {
  it("drives every port method with argv that never names graphql or pr view", async () => {
    const gh = routedGh();
    const port = githubPort(ghCliWire(gh.exec));
    const calls: Record<keyof typeof port, () => Promise<unknown>> = {
      getHeadSha: () => port.getHeadSha(REPO, "topic"),
      ensureBranch: () => port.ensureBranch(REPO, "topic", H1),
      deleteRef: () => port.deleteRef(REPO, { branch: "topic", repo: REPO }),
      getFile: () => port.getFile(REPO, "docs/a.md", "topic"),
      putFile: () => port.putFile(REPO, { path: "docs/a.md", branch: "topic", content: "x", message: "m", expectedBlobSha: H2 }),
      findPr: () => port.findPr(REPO, "topic"),
      listOpenPrs: () => port.listOpenPrs(REPO, "to"),
      openPr: () => port.openPr(REPO, { head: "topic", base: "main", title: "t", body: "b" }),
      getPr: () => port.getPr(REPO, 7),
      requiredChecks: () => port.requiredChecks(REPO, "main"),
      reviewRulesBypassable: () => port.reviewRulesBypassable(REPO, "main"),
      checkRuns: () => port.checkRuns(REPO, H1),
      latestCheckRuns: () => port.latestCheckRuns(REPO, H1),
      getCommit: () => port.getCommit(REPO, H1),
      jobLogTail: () => port.jobLogTail(REPO, 42, 2),
      updateBranch: () => port.updateBranch(REPO, 7, H1),
      merge: () => port.merge(REPO, 7, H1, "squash"),
      rerunFailed: () => port.rerunFailed(REPO, 55),
      listPrFiles: () => port.listPrFiles(REPO, 7),
      compareFiles: () => port.compareFiles(REPO, "main", "topic"),
      upsertComment: () => port.upsertComment(REPO, 7, "<!-- m -->", "<!-- m --> b"),
    };

    for (const call of Object.values(calls)) await call();

    expect(Object.keys(calls).sort()).toEqual(Object.keys(port).sort());
    expect(gh.argv.every((args) => args[0] === "api")).toBe(true);
    expect(gh.argv.filter((args) => args.some((arg) => /graphql/i.test(arg)) || args.join(" ").includes("pr view"))).toEqual([]);
  });

  it("reads the head repo, deletes a ref with DELETE, lists open PRs and tails a job log", async () => {
    const gh = routedGh();
    const wire = ghCliWire(gh.exec);
    const port = githubPort(wire);

    const open = await port.listOpenPrs(REPO);
    const deleted = await port.deleteRef(REPO, { branch: open[0]!.headRef, repo: open[0]!.headRepo });
    const log = await port.jobLogTail(REPO, 42, 2);

    expect(open).toMatchObject([{ number: 7, headRef: "topic", headRepo: REPO }]);
    expect(deleted).toEqual({ done: true });
    expect(log).toBe("line 2\nline 3");
    expect(gh.argv).toContainEqual(["api", "-i", "-X", "GET", "repos/octo/demo/pulls", "-f", "state=open", "-f", "per_page=100"]);
    expect(gh.argv).toContainEqual(["api", "-i", "-X", "DELETE", "repos/octo/demo/git/refs/heads/topic"]);
    expect(gh.argv).toContainEqual(["api", "-i", "-X", "GET", "repos/octo/demo/actions/jobs/42/logs"]);
  });

  it("filters open PRs by head prefix", async () => {
    const other = { ...pull, number: 8, head: { ...pull.head, ref: "shepherd/x", sha: H2 } };
    const gh = scriptedGh({ "repos/octo/demo/pulls": JSON.stringify([pull, other]) });

    const open = await githubPort(ghCliWire(gh.exec)).listOpenPrs(REPO, "shepherd/");

    expect(open.map((pr) => pr.number)).toEqual([8]);
  });
});

describe("gh api adapter, conditional GETs", () => {
  const rules = [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "check" }] } }];

  it("sends the stored ETag and answers a 304 with the cached body", async () => {
    const answers = [included(200, { ETag: 'W/"e1"' }, rules), included(304, { ETag: '"e1"' }, undefined)];
    const gh = scriptedGhSequence(answers);
    const wire = ghCliWire(gh.exec);

    const first = await wire.getBranchRules(REPO, "main");
    const second = await wire.getBranchRules(REPO, "main");

    expect(second).toEqual(first);
    expect(second).toEqual({ contexts: ["check"], strict: false });
    expect(gh.calls[0]?.args).not.toContain("-H");
    expect(gh.calls[1]?.args.slice(-2)).toEqual(["-H", 'If-None-Match: W/"e1"']);
  });

  it("keeps following pages when the first page answers 304, from the cached Link", async () => {
    const link = { Link: '<https://api.github.com/repositories/9/pulls?state=open&page=2>; rel="next"' };
    const page2 = { ...pull, number: 8 };
    const answers = [included(200, { ETag: '"p1"', ...link }, [pull]), included(200, { ETag: '"p2"' }, [page2]), included(304, {}, undefined), included(304, {}, undefined)];
    const gh = scriptedGhSequence(answers);
    const wire = ghCliWire(gh.exec);

    await wire.listOpenPrs(REPO);
    const again = await wire.listOpenPrs(REPO);

    expect(again.map((pr) => pr.number)).toEqual([7, 8]);
    expect(gh.calls[3]?.args).toContain('If-None-Match: "p2"');
  });

  it("refuses a next-page link that leaves api.github.com", async () => {
    const gh = scriptedGhSequence([included(200, { Link: '<https://evil.test/x?page=2>; rel="next"' }, [pull])]);

    await expect(ghCliWire(gh.exec).listOpenPrs(REPO)).rejects.toThrow(/outside https:\/\/api.github.com/);
  });

  it("reads a 404 status from the included status line", async () => {
    const gh = scriptedGhSequence([included(404, {}, { message: "Not Found" })]);

    expect(await ghCliWire(gh.exec).getRef(REPO, "gone")).toBeNull();
  });
});

function scriptedGhSequence(answers: GhResult[]): { exec: GhExec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: GhExec = async (args, input) => {
    calls.push({ args, input });
    const answer = answers[calls.length - 1];
    if (!answer) throw new Error(`unexpected call ${calls.length}: ${args.join(" ")}`);
    return answer;
  };
  return { exec, calls };
}
