import { FakeHttpError, fakeGitHub, fakeSha, githubPort, successRun, type CheckRun, type GitHubWire } from "@titan-design/github";
import { describe, expect, it } from "vitest";
import { landRoutes } from "./land.js";
import { liveOrRecorded } from "./land-ci.js";
import { REPO } from "../test-support/land.js";

const MIN = 60_000;
const POLL_MS = 30_000;
const TIMEOUT_MS = 45 * MIN;
const HEAD = fakeSha("e8c0b023");
const RECORDED = ["validate", "dag-check", "hub-compose", "egress-scan"];
const WITHOUT_EGRESS = ["validate", "dag-check", "hub-compose"];
const GREEN_WITHOUT_EGRESS = [successRun("validate", 1), successRun("dag-check", 2), successRun("hub-compose", 3)];

interface HarnessOptions {
  recorded?: string[];
  liveAtStart?: string[];
  /** The ruleset's contexts from `changesAtMs` on the fake clock. */
  liveLater?: string[];
  changesAtMs?: number;
  runs?: CheckRun[];
  rulesUnreadable?: boolean;
}

/** tp#1153 run 85beb471: land-rules recorded `recorded` at round start; the ruleset may change while ci-wait polls. */
function harness(options: HarnessOptions = {}) {
  const fake = fakeGitHub();
  fake.rules = { contexts: options.liveAtStart ?? RECORDED, strict: false };
  fake.addPr({ headSha: HEAD, mergeableState: "clean" });
  fake.setRuns(HEAD, options.runs ?? GREEN_WITHOUT_EGRESS);
  const clock = { now: 0 };
  const wire: GitHubWire = options.rulesUnreadable
    ? { ...fake.wire, getBranchRules: async () => Promise.reject(new FakeHttpError(500, "Server Error")) }
    : fake.wire;
  const route = landRoutes({
    port: githubPort(wire),
    now: () => clock.now,
    sleep: async (ms) => {
      clock.now += ms;
      if (options.liveLater && clock.now >= (options.changesAtMs ?? 0)) fake.rules = { contexts: options.liveLater, strict: false };
    },
    pollMs: POLL_MS,
    ciTimeoutMs: TIMEOUT_MS,
  }).find((candidate) => candidate.match === "ci-wait")!;
  const prompt = JSON.stringify({ repo: REPO, pr: 1, contexts: options.recorded ?? RECORDED, strict: false });
  const ciWait = async () => {
    const out = (await route.runner.run({ runId: "85beb471", workflowName: "w", stepId: "ci-wait:r12:2", iteration: 0, prompt, signal: new AbortController().signal, attempt: 1, requestKey: "k" })) as { ok: boolean; output?: string; error?: string };
    return { ...out, result: out.output ? JSON.parse(out.output).result : undefined };
  };
  return { ciWait, clock };
}

describe("ci-wait when the base's ruleset drops a required context mid-wait (tp#1153 85beb471)", () => {
  it("returns green once egress-scan is no longer required, instead of timing out waiting on it", async () => {
    const h = harness({ liveLater: WITHOUT_EGRESS, changesAtMs: 30 * MIN });

    const out = await h.ciWait();

    expect(out.ok).toBe(true);
    expect(out.result.verdict).toBe("green");
    expect(out.result.contexts).toEqual(WITHOUT_EGRESS);
    expect(h.clock.now).toBeGreaterThanOrEqual(30 * MIN);
    expect(h.clock.now).toBeLessThan(TIMEOUT_MS);
  });

  it("returns green on the first poll when the context was dropped before the wait began", async () => {
    const h = harness({ liveAtStart: WITHOUT_EGRESS });

    const out = await h.ciWait();

    expect(out.result.verdict).toBe("green");
    expect(h.clock.now).toBe(0);
  });

  it("waits on a context the ruleset added since round start instead of going green on the recorded list", async () => {
    const h = harness({ recorded: ["validate"], liveAtStart: ["validate", "lint"], runs: [successRun("validate", 1)] });

    const out = await h.ciWait();

    expect(out.ok).toBe(false);
    expect(out.error).toContain("waiting on lint");
  });
});

describe("ci-wait fails closed when the live required contexts cannot be trusted", () => {
  it("keeps waiting on the recorded egress-scan and times out when the rules read is unreadable", async () => {
    const h = harness({ rulesUnreadable: true });

    const out = await h.ciWait();

    expect(out.ok).toBe(false);
    expect(out.error).toContain("timed out");
    expect(out.error).toContain("egress-scan");
  });

  it("keeps waiting on the recorded egress-scan and times out when the live list turns empty", async () => {
    const h = harness({ liveLater: [], changesAtMs: 10 * MIN });

    const out = await h.ciWait();

    expect(out.ok).toBe(false);
    expect(out.error).toContain("timed out");
    expect(out.error).toContain("egress-scan");
  });
});

describe("liveOrRecorded", () => {
  const recorded = ["validate", "egress-scan"];
  it.each([
    { scenario: "a failed read keeps the recorded list", recorded, live: () => Promise.reject(new Error("HTTP 500")), expected: recorded },
    { scenario: "an empty live list over a non-empty recorded one keeps the recorded list", recorded, live: async () => [], expected: recorded },
    { scenario: "an empty live list over an empty recorded one stays empty", recorded: [], live: async () => [], expected: [] },
    { scenario: "a readable live list wins", recorded, live: async () => ["validate"], expected: ["validate"] },
  ])("$scenario", async ({ recorded: list, live, expected }) => {
    expect(await liveOrRecorded(list, live)).toEqual(expected);
  });
});
