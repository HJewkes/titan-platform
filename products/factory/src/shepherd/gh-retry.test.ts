import { fakeGitHub, githubPort, successRun, type GitHubPort } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { landPrRoutes, landPrWorkflow } from "../workflows/land-pr.js";
import { failureClassOf } from "./failure-class.js";
import { retryingGhServerErrors } from "./gh-retry.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const CONNECTING = "gh api -i -X GET failed (1): error connecting to api.github.com\ncheck your internet connection";

/** A land-pr run on one green PR whose port fails its first `failures` merges with `error`. */
function world(failures: number, error: string) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const real = githubPort(fake.wire);
  let left = failures;
  const port: GitHubPort = {
    ...real,
    merge: async (...args) => {
      if (left-- > 0) throw new Error(error);
      return real.merge(...args);
    },
  };
  const waits: number[] = [];
  const sleep = async (ms: number) => void waits.push(ms);
  const routes = retryingGhServerErrors(landPrRoutes({ port, now: () => 0, sleep }), { sleep });
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
    expect(failureClassOf(status?.error ?? "")).toBe("gh-api-5xx");
    expect(status?.error).toContain("after 3 gh-api-5xx retries");
  });

  it("does not retry a failure of another class", async () => {
    const { host, runId, waits } = world(99, "gh api -i -X PUT failed (1): gh: Base branch was modified. (HTTP 405)");

    await approve(host, runId);

    expect(waits).toEqual([]);
    expect(host.runtime.status(runId)?.status).toBe("failed");
  });
});

describe("retryingGhServerErrors on land-rules", () => {
  it("does not retry a land-rules refusal even when its text names a gh api failure", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const [route] = retryingGhServerErrors(
      [{ match: "land-rules", onRestart: "repeat", runner: { run: async () => (calls++, { ok: false as const, error: "gh api failed (1): HTTP 503", retryable: false }) } }],
      { sleep: async (ms) => void sleeps.push(ms) },
    );

    const outcome = await route!.runner.run({ runId: "r", workflowName: "w", stepId: "land-rules", iteration: 0, prompt: "{}", signal: new AbortController().signal, attempt: 0, requestKey: "k" });

    expect(outcome.ok).toBe(false);
    expect(calls).toBe(1);
    expect(sleeps).toEqual([]);
  });
});
