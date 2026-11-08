import { describe, expect, it } from "vitest";
import { rateBudget } from "./budget.js";
import { GhError, type GhExec, type GhExecOptions, type GhResult } from "./exec.js";
import { FakeHttpError, fakeGitHub, fakeSha } from "./fake.js";
import { API, fakeFetch, rejectionOf } from "./fetch-fake.test-helpers.js";
import { ghCliWire } from "./gh-cli.js";
import { octokitClient } from "./octokit-client.js";
import { octokitWire } from "./octokit-wire.js";
import { githubPort } from "./port.js";
import { GitHubInputError } from "./validate.js";

const REPO = "octo/demo";
const HEAD = fakeSha("head");
const TOKEN = "ghs_synthetic_installation_token";
const approval = { commitId: HEAD, body: "<!-- marker --> approved" };

interface Call {
  args: readonly string[];
  input?: string;
  options?: GhExecOptions;
}

function scripted(answer: (call: Call) => GhResult): { exec: GhExec; calls: Call[] } {
  const calls: Call[] = [];
  return { calls, exec: async (args, input, options) => (calls.push({ args, input, options }), answer({ args, input, options })) };
}

function answer(body: unknown, headers: Record<string, string> = {}): GhResult {
  const head = ["HTTP/2.0 200 OK", ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`)].join("\r\n");
  return { code: 0, stdout: `${head}\r\n\r\n${body === undefined ? "" : JSON.stringify(body)}`, stderr: "" };
}

const appPort = (gh: { exec: GhExec }) => githubPort(ghCliWire(gh.exec, { budget: rateBudget(), appToken: async () => TOKEN }));
const ghReview = (id: number, user: { login: string; type: string } | null, commitId: string | null, body: string | null) => ({ id, state: "APPROVED", commit_id: commitId, body, user });

describe("gh wire reviews", () => {
  it("createReview posts an APPROVE at the commit under the App token only", async () => {
    const gh = scripted(() => answer({ id: 31 }));

    const result = await appPort(gh).createReview(REPO, 7, approval);

    const call = gh.calls[0]!;
    expect(result).toEqual({ id: 31 });
    expect(call.args).toEqual(["api", "-i", "-X", "POST", `repos/${REPO}/pulls/7/reviews`, "--input", "-"]);
    expect(JSON.parse(call.input!)).toEqual({ commit_id: HEAD, event: "APPROVE", body: approval.body });
    expect(call.options?.env).toEqual({ GH_TOKEN: TOKEN });
  });

  it("dismissReview sends a PUT to the review's dismissals under the App token", async () => {
    const gh = scripted(() => answer({ id: 9 }));

    await appPort(gh).dismissReview(REPO, 7, 9, "a newer head is not reviewed");

    const call = gh.calls[0]!;
    expect(call.args).toEqual(["api", "-i", "-X", "PUT", `repos/${REPO}/pulls/7/reviews/9/dismissals`, "--input", "-"]);
    expect(JSON.parse(call.input!)).toEqual({ message: "a newer head is not reviewed", event: "DISMISS" });
    expect(call.options?.env).toEqual({ GH_TOKEN: TOKEN });
  });

  it("both review writes refuse a wire with no App token provider before any exec", async () => {
    const gh = scripted(() => answer({ id: 1 }));
    const port = githubPort(ghCliWire(gh.exec, { budget: rateBudget() }));

    await expect(port.createReview(REPO, 7, approval)).rejects.toThrow(/createReview needs a GitHub App token provider/);
    await expect(port.dismissReview(REPO, 7, 9, "m")).rejects.toThrow(/dismissReview needs a GitHub App token provider/);
    expect(gh.calls).toEqual([]);
  });

  it("a failed review post keeps its HTTP status and drops an App token of no known shape from the error", async () => {
    const shapeless = "synthetic-app-secret-of-no-token-shape";
    const gh = scripted(({ options }) => ({ code: 1, stdout: "", stderr: `gh: denied for ${options!.env!.GH_TOKEN} (HTTP 422)` }));
    const port = githubPort(ghCliWire(gh.exec, { budget: rateBudget(), appToken: async () => shapeless }));

    const error = await rejectionOf(port.createReview(REPO, 7, approval), GhError);

    expect(error.status).toBe(422);
    expect(`${error.message}\n${error.result.stderr}`).not.toContain(shapeless);
  });

  it("listReviews reads every page as the user and maps login, user type and commit", async () => {
    const next = { link: `<https://api.github.com/repositories/1/pulls/7/reviews?per_page=100&page=2>; rel="next"` };
    const gh = scripted(({ args }) => (args.join(" ").includes("page=2")
      ? answer([ghReview(12, null, null, null)])
      : answer([ghReview(11, { login: "shepherd-app[bot]", type: "Bot" }, HEAD, "ok")], next)));

    const reviews = await appPort(gh).listReviews(REPO, 7);

    expect(reviews).toEqual([
      { id: 11, state: "APPROVED", commitId: HEAD, login: "shepherd-app[bot]", userType: "Bot", body: "ok" },
      { id: 12, state: "APPROVED", commitId: null, login: "", userType: "", body: "" },
    ]);
    expect(gh.calls.every((call) => call.options?.env?.GH_TOKEN === undefined)).toBe(true);
  });
});

describe("port review validation", () => {
  it("refuses a short commit, a bad review id and an empty dismissal message before any call", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: HEAD });
    const port = githubPort(fake.wire);

    await expect(port.createReview(REPO, 1, { ...approval, commitId: HEAD.slice(0, 7) })).rejects.toBeInstanceOf(GitHubInputError);
    await expect(port.dismissReview(REPO, 1, 0, "m")).rejects.toBeInstanceOf(GitHubInputError);
    await expect(port.dismissReview(REPO, 1, 5, "  ")).rejects.toBeInstanceOf(GitHubInputError);
    await expect(port.listReviews(REPO, -1)).rejects.toBeInstanceOf(GitHubInputError);
    expect(fake.calls).toEqual([]);
  });
});

describe("octokit wire reviews", () => {
  it("posts the approval and the dismissal through the App's client, never the user's", async () => {
    const user = fakeFetch(() => ({ status: 200, body: [] }));
    const app = fakeFetch(() => ({ status: 200, body: { id: 31 } }));
    const client = octokitClient({ fetch: user.fetch, token: async () => "ghp_synthetic_user_token", throttleId: "reviews-user" });
    const port = githubPort(octokitWire({ client, appToken: async () => TOKEN, appClientOptions: { fetch: app.fetch, throttleId: "reviews-app" } }));

    await port.createReview(REPO, 7, approval);
    await port.dismissReview(REPO, 7, 31, "stale");

    expect(user.calls).toEqual([]);
    expect(app.calls.map((call) => [call.method, call.url])).toEqual([["POST", `${API}repos/${REPO}/pulls/7/reviews`], ["PUT", `${API}repos/${REPO}/pulls/7/reviews/31/dismissals`]]);
    expect(app.calls.every((call) => call.headers.authorization === `bearer ${TOKEN}`)).toBe(true);
  });
});

describe("fake reviews", () => {
  it("an approval lists as the App's bot review at its commit, and a dismissal marks it dismissed", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: HEAD });
    const port = githubPort(fake.wire);

    const { id } = await port.createReview(REPO, 1, approval);
    const before = await port.listReviews(REPO, 1);
    await port.dismissReview(REPO, 1, id, "stale");

    expect(before).toEqual([{ id, state: "APPROVED", commitId: HEAD, login: "fake-app[bot]", userType: "Bot", body: approval.body }]);
    expect((await port.listReviews(REPO, 1)).map((review) => review.state)).toEqual(["DISMISSED"]);
  });

  it("dismissal answers 404 for an unknown review and 422 for a comment review, as GitHub does", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: HEAD });
    fake.reviews.set(1, [{ id: 3, state: "COMMENTED", commitId: HEAD, login: "someone", userType: "User", body: "" }]);
    const port = githubPort(fake.wire);

    await expect(port.dismissReview(REPO, 1, 99, "m")).rejects.toMatchObject({ status: 404 });
    await expect(port.dismissReview(REPO, 1, 3, "m")).rejects.toMatchObject({ status: 422 });
    expect(fake.reviews.get(1)?.[0]?.state).toBe("COMMENTED");
  });

  it("a queued fault fails one review post, and a landed fault still records the review", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: HEAD });
    fake.createReviewFaults = [{ error: new FakeHttpError(502, "lost") }, { error: new FakeHttpError(502, "lost after"), lands: true }];
    const port = githubPort(fake.wire);

    await expect(port.createReview(REPO, 1, approval)).rejects.toThrow(/lost$/);
    await expect(port.createReview(REPO, 1, approval)).rejects.toThrow(/lost after/);
    await port.createReview(REPO, 1, approval);

    expect(await port.listReviews(REPO, 1)).toHaveLength(2);
    expect(fake.createReviewFaults).toEqual([]);
  });

  it("a landed dismissal fault throws after the review is already dismissed", async () => {
    const fake = fakeGitHub();
    fake.addPr({ headSha: HEAD });
    const port = githubPort(fake.wire);
    const { id } = await port.createReview(REPO, 1, approval);
    fake.dismissReviewFaults = [{ error: new FakeHttpError(502, "lost after"), lands: true }];

    await expect(port.dismissReview(REPO, 1, id, "stale")).rejects.toThrow(/lost after/);

    expect((await port.listReviews(REPO, 1))[0]?.state).toBe("DISMISSED");
  });
});
