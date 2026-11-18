import { fakeGitHub, fakeSha, ghCliWire, githubPort, octokitClient, octokitWire, rateBudget, successRun, type GhResult, type GitHubWire } from "@titan-design/github";
import type { RoutedStepInput, StepRoute } from "@titan-design/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { fakeLocator } from "../test-support/fakes.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { codeRoute } from "../workflows/land-routes.js";
import { failureClassOf } from "./failure-class.js";
import { rateLimitWaitMs, retryingGhServerErrors } from "./gh-retry.js";
import { OBSERVE_STEP } from "./observe.js";
import type { ReviewRequest, ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import type { EffectivePolicy } from "./policy-schema.js";
import { mergeVerdict } from "./review.js";
import { shepherdStoreRef } from "./store.js";

const MINUTE = 60_000;
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "trusted-seat" };
const reviewer = { agentId: "agent-rv-1", sessionId: "session-rv-1" };
const phases: ShepherdPhases = {
  wake: async () => ({ kind: "unhandled", reason: "no agent in this test" }),
  review: (ctx, request: ReviewRequest) =>
    mergeVerdict(ctx, { ...request, head: request.headSha, verdict: { value: "MERGE", head: request.headSha, locator: fakeLocator({ sourceId: "transcript-1" }) }, resolver: reviewer, dispatchedReviewer: reviewer, seatGrants: ["merge-on-green-approve"] }),
};

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** Shaped like the 2026-10-12 18:51Z sh-observe answer: a core primary limit, spent, with GitHub's own message; the ids are synthetic. */
function primaryLimit403(resetS: number): GhResult {
  const head = ["HTTP/2.0 403 Forbidden", "X-Ratelimit-Limit: 5000", "X-Ratelimit-Remaining: 0", "X-Ratelimit-Used: 5000", `X-Ratelimit-Reset: ${resetS}`, "X-Ratelimit-Resource: core"].join("\r\n");
  const body = JSON.stringify({ message: "API rate limit exceeded for user ID 1. If you reach out to GitHub Support for help, please include the request ID 0000:0000:0000000:0000000:00000000.", documentation_url: "https://docs.github.com/rest/overview/rate-limits-for-the-rest-api", status: "403" });
  return { code: 1, stdout: `${head}\r\n\r\n${body}`, stderr: "gh: API rate limit exceeded for user ID 1. If you reach out to GitHub Support for help, please include the request ID 0000:0000:0000000:0000000:00000000. (HTTP 403)\n" };
}

function forbidden403(): GhResult {
  const body = JSON.stringify({ message: "Resource not accessible by integration", status: "403" });
  return { code: 1, stdout: `HTTP/2.0 403 Forbidden\r\nX-Ratelimit-Remaining: 4000\r\n\r\n${body}`, stderr: "gh: Resource not accessible by integration (HTTP 403)\n" };
}

/**
 * A shepherd-pr run on the full factory wiring, whose first `refusals` observe reads go to GitHub through `ghCliWire`
 * and are answered `answer`; every other read is the fake's. Sleeps advance the clock and are recorded.
 */
function world(refusals: number, answer: (nowMs: number) => GhResult) {
  const fake = fakeGitHub();
  const clock = { now: 1_760_295_060_000 };
  const sleeps: number[] = [];
  const cliReads: string[] = [];
  const cli = ghCliWire(async (args) => (cliReads.push(args.join(" ")), answer(clock.now)), { budget: rateBudget(), sleep: async () => undefined });
  let observing = false;
  let left = refusals;
  const wire: GitHubWire = { ...fake.wire, getPr: (repo, number) => (observing && left-- > 0 ? cli.getPr(repo, number) : fake.wire.getPr(repo, number)) };
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const tick = async (ms: number, signal: AbortSignal) => (sleeps.push(ms), (clock.now += ms), sleep(1, signal));
  const store = shepherdStoreRef();
  const base = factoryRoutesFor({ port: githubPort(wire), store, now: () => clock.now, sleep: tick, park: async () => ({ lines: [] }), registry: async () => "trusted" as const, mergeTree: async () => "clean" });
  const observed = (route: StepRoute): StepRoute => ({ ...route, runner: { run: async (input) => ((observing = true), route.runner.run(input).finally(() => (observing = false))) } });
  const routes = Object.assign(base.map((route) => (route.match === OBSERVE_STEP ? observed(route) : route)), { database: base.database, shepherd: base.shepherd });
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge") });
  fake.prFiles.set(1, [{ path: "src/a.ts", status: "modified" }]);
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  return { fake, host, runId, sleeps, cliReads, clock };
}

const observeRecords = (host: FactoryHost, runId: string) => Object.values(host.runtime.status(runId)!.stepResults).filter((result) => result.stepId.startsWith(OBSERVE_STEP));

describe("a Shepherd run whose sh-observe read meets a GitHub rate limit", () => {
  it("replays the 2026-10-12 18:51Z primary-limit 403 through ghCliWire, waits out the reset and goes on to merge", async () => {
    const w = world(1, (nowMs) => primaryLimit403(Math.floor(nowMs / 1000) + 600));

    await vi.waitFor(() => expect(w.fake.pr(1).merged).toBe(true));

    expect(w.host.runtime.status(w.runId)?.status).not.toBe("failed");
    expect(w.cliReads).toHaveLength(1);
    const waits = w.sleeps.filter((ms) => ms >= 10 * MINUTE);
    expect(waits).toHaveLength(1);
    expect(waits[0]).toBeGreaterThan(10 * MINUTE);
    expect(waits[0]).toBeLessThanOrEqual(10 * MINUTE + 5_000);
    expect(JSON.stringify(observeRecords(w.host, w.runId).map((result) => result.data))).toContain("gh-rate-limit");
  });

  it("fails at once on a 403 that is not a rate limit", async () => {
    const w = world(1, forbidden403);

    await vi.waitFor(() => expect(w.host.runtime.status(w.runId)?.status).toBe("failed"));

    const status = w.host.runtime.status(w.runId)!;
    expect(w.cliReads).toHaveLength(1);
    expect(status.error).toContain("Resource not accessible by integration");
    expect(failureClassOf(status.error ?? "", status.errorClass)).toBe("other");
    expect(w.fake.pr(1).merged).toBe(false);
  });
});

const NOW = 1_760_295_060_000;
const STEP: RoutedStepInput = { runId: "r", workflowName: "w", stepId: `${OBSERVE_STEP}:h`, iteration: 0, prompt: "{}", signal: new AbortController().signal, attempt: 0, requestKey: "k" };

/** One repeat-safe route that fails with each of `errors` in turn, then succeeds; its sleeps are recorded, the clock never moves. */
function retried(errors: readonly Error[]) {
  const sleeps: number[] = [];
  let calls = 0;
  const body = async () => {
    const error = errors[calls++];
    if (error) throw error;
    return {};
  };
  const [route] = retryingGhServerErrors([codeRoute(OBSERVE_STEP, () => NOW, body)], { sleep: async (ms) => void sleeps.push(ms), now: () => NOW });
  return { outcome: () => route!.runner.run(STEP), sleeps, calls: () => calls };
}

async function errorOf(pending: Promise<unknown>): Promise<Error> {
  const error = await pending.then(() => undefined, (rejection: unknown) => rejection);
  if (!(error instanceof Error)) throw new Error("expected a rejection");
  return error;
}

const cliError = (result: GhResult, read: (wire: GitHubWire) => Promise<unknown> = (wire) => wire.getPr(REPO, 1)) => errorOf(read(ghCliWire(async () => result, { budget: rateBudget(), sleep: async () => undefined })));

function octokitError(status: number, headers: Record<string, string>, message: string): Promise<Error> {
  const fetch: typeof globalThis.fetch = async () => new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json", ...headers } });
  const client = octokitClient({ fetch, token: async () => "synthetic-token", throttleId: "gh-rate-limit-test", budget: rateBudget() });
  return errorOf(octokitWire({ client }).getPr(REPO, 1));
}

describe("retryingGhServerErrors on a rate limit", () => {
  it("re-reads after the Octokit transport's limited answer, which carries the same marker", async () => {
    const resetS = NOW / 1000 + 1_200;
    const error = await octokitError(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetS), "x-ratelimit-resource": "core" }, "API rate limit exceeded for user ID 1.");
    const step = retried([error]);

    expect((await step.outcome()).ok).toBe(true);

    expect(step.sleeps).toEqual([1_200_000 + 5_000]);
  });

  it("fails on the third limit after two waits, filed gh-rate-limit", async () => {
    const error = await cliError(primaryLimit403(NOW / 1000 + 60));
    const step = retried([error, error, error]);

    const outcome = await step.outcome();

    expect(outcome.ok).toBe(false);
    expect(step.sleeps).toEqual([65_000, 65_000]);
    expect(step.calls()).toBe(3);
    const failed = outcome.ok ? "" : outcome.error;
    expect(failed).toContain("after 2 gh-rate-limit retries");
    expect(outcome.ok ? undefined : outcome.errorClass).toBe("gh-rate-limit");
  });

  it("never repeats a write that met a limit", async () => {
    const error = await cliError(primaryLimit403(NOW / 1000 + 60),(wire) => wire.createComment(REPO, 1, "hello"));
    const step = retried([error]);

    expect((await step.outcome()).ok).toBe(false);

    expect(step.sleeps).toEqual([]);
    expect(step.calls()).toBe(1);
  });
});

describe("rateLimitWaitMs", () => {
  const marked = (fields: string) => `[gh-rate-limit status=403 method=GET ${fields}] gh api -i repos/octo/demo failed (1): gh: You have exceeded a secondary rate limit (HTTP 403)`;

  it("waits a secondary limit's retry-after", () => {
    expect(rateLimitWaitMs(marked("retry-after=90"), NOW)).toBe(90_000);
  });

  it("waits 60 s when the limit names no reset", () => {
    expect(rateLimitWaitMs("[gh-rate-limit status=429 method=GET] gh api -i repos/octo/demo failed (1): gh: HTTP 429", NOW)).toBe(60_000);
  });

  it("caps one wait at 61 minutes", () => {
    expect(rateLimitWaitMs(marked(`x-ratelimit-remaining=0 x-ratelimit-reset=${NOW / 1000 + 3 * 3600}`), NOW)).toBe(61 * MINUTE);
  });

  it("has no wait for unmarked text, whatever it says", () => {
    expect(rateLimitWaitMs("gh api -i repos/octo/demo failed (1): API rate limit exceeded (HTTP 403)", NOW)).toBeUndefined();
  });
});
