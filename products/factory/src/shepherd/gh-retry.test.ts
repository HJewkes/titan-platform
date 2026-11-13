import { GhError, fakeGitHub, githubPort, successRun, type GitHubPort } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { landPrRoutes, landPrWorkflow } from "../workflows/land-pr.js";
import { codeRoute } from "../workflows/land-routes.js";
import { hostPostMerge } from "../workflows/post-merge-adapter.js";
import { hostCarryPorts } from "./carry-cache-adapter.js";
import { failureClassOf } from "./failure-class.js";
import { retryingGhServerErrors } from "./gh-retry.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A failed call as the transport throws it, whose message reads `gh <args> failed (1): <said>`. */
const ghFailure = (args: string, said: string) => new GhError(args.split(" "), { code: 1, stdout: "", stderr: said });
const CONNECTING = ghFailure("api -i -X GET", "error connecting to api.github.com\ncheck your internet connection");

/** A land-pr run on one green PR whose port fails its first `failures` merges with `error`. */
function world(failures: number, error: Error) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const real = githubPort(fake.wire);
  let left = failures;
  const port: GitHubPort = {
    ...real,
    merge: async (...args) => {
      if (left-- > 0) throw error;
      return real.merge(...args);
    },
  };
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const routes = retryingGhServerErrors(landPrRoutes({ ...hostPostMerge(), gitCache: hostCarryPorts, port, now: () => 0, sleep }), { sleep });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [landPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  const runId = host.runtime.start("land-pr", { repo: REPO, pr: "1", task: "TASK-1" });
  return { host, fake, runId, waits };
}

async function approve(host: FactoryHost, runId: string): Promise<void> {
  await gateOpened(host, gateId(runId, "approve-merge"));
  host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  await host.runtime.wait(runId);
}

describe("retryingGhServerErrors", () => {
  it("merges on the retry when the first gh api call cannot connect, and records the retry", async () => {
    const { host, fake, runId, waits } = world(1, CONNECTING);

    await approve(host, runId);

    expect(host.runtime.status(runId)?.status).toBe("completed");
    expect(fake.effects).toMatchObject({ merge: 1 });
    expect(waits).toEqual([5_000]);
    const merged = Object.values(host.runtime.status(runId)!.stepResults).find((result) => result.stepId.startsWith("merge:"));
    expect(JSON.stringify(merged?.data)).toContain("ghRetries");
  });

  it("fails after three retries with the gh-api-5xx class intact", async () => {
    const { host, runId, waits } = world(99, CONNECTING);

    await approve(host, runId);

    const status = host.runtime.status(runId);
    expect(status?.status).toBe("failed");
    expect(waits).toEqual([5_000, 20_000, 60_000]);
    expect(failureClassOf(status?.error ?? "", status?.errorClass)).toBe("gh-api-5xx");
    expect(status?.error).toContain("after 3 gh-api-5xx retries");
  });

  it("does not retry a failure of another class", async () => {
    const { host, runId, waits } = world(99, ghFailure("api -i -X PUT", "gh: Base branch was modified. (HTTP 405)"));

    await approve(host, runId);

    expect(waits).toEqual([]);
    expect(host.runtime.status(runId)?.status).toBe("failed");
  });
});

const timedOut = (method: string, path: string) => ghFailure(`api -X ${method} ${path}`, `${method} /${path} timed out after 60000 ms`);
const PULLS_TIMEOUT = timedOut("GET", "repos/acme/widgets/pulls?state=open&per_page=100");

/** One repeat-safe route at `stepId` that fails with each of `errors` in turn, then succeeds. */
function scripted(stepId: string, errors: readonly Error[]) {
  let calls = 0;
  const sleeps: number[] = [];
  const body = async () => {
    const error = errors[calls++];
    if (error) throw error;
    return {};
  };
  const [route] = retryingGhServerErrors([codeRoute(stepId, () => 0, body)], { sleep: async (ms) => void sleeps.push(ms) });
  const outcome = route!.runner.run({ runId: "r", workflowName: "w", stepId, iteration: 0, prompt: "{}", signal: new AbortController().signal, attempt: 0, requestKey: "k" });
  return { outcome, calls: () => calls, sleeps };
}

describe("retryingGhServerErrors on a GitHub read timeout", () => {
  it("merges on the retry when the merge step's pulls read times out once", async () => {
    const { host, fake, runId, waits } = world(1, PULLS_TIMEOUT);

    await approve(host, runId);

    expect(host.runtime.status(runId)?.status).toBe("completed");
    expect(fake.effects).toMatchObject({ merge: 1 });
    expect(waits).toEqual([5_000]);
  });

  it("retries sh-observe through a 5xx and then timeouts, and fails filed gh-api-5xx once the backoff is spent", async () => {
    const run = scripted("sh-observe:abc", [ghFailure("api -X GET repos/acme/widgets/pulls", "Bad Gateway (HTTP 502)"), PULLS_TIMEOUT, PULLS_TIMEOUT, PULLS_TIMEOUT]);

    const outcome = await run.outcome;

    expect(run.calls()).toBe(4);
    expect(run.sleeps).toEqual([5_000, 20_000, 60_000]);
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? undefined : outcome.errorClass).toBe("gh-api-5xx");
    expect(outcome.ok ? "" : outcome.error).toContain("(after 3 gh-api-5xx retries)");
  });

  it("does not send a timed-out write again", async () => {
    const run = scripted("merge:0", [timedOut("PUT", "repos/acme/widgets/pulls/1/merge")]);

    const outcome = await run.outcome;

    expect(outcome.ok).toBe(false);
    expect(run.calls()).toBe(1);
    expect(run.sleeps).toEqual([]);
  });
});

describe("retryingGhServerErrors on land-rules", () => {
  it("does not retry a land-rules refusal even when its text names a gh api failure", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const [route] = retryingGhServerErrors(
      [codeRoute("land-rules", () => 0, async () => {
        calls++;
        throw ghFailure("api", "HTTP 503");
      })],
      { sleep: async (ms) => void sleeps.push(ms) },
    );

    const outcome = await route!.runner.run({ runId: "r", workflowName: "w", stepId: "land-rules", iteration: 0, prompt: "{}", signal: new AbortController().signal, attempt: 0, requestKey: "k" });

    expect(outcome.ok).toBe(false);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
