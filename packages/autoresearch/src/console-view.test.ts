import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { ideaId, type Outcome } from "./schemas.js";
import { FIXTURE_POLICY, fakeArPorts, fixtureRepo, proposal, removeFixture, scriptedPlanner, type FixtureRepo } from "./test-support/fake-ports.js";
import { openTestHost, type TestHost } from "./test-support/host.js";
import { stopOutcomes } from "./test-support/runs.js";
import { AUTORESEARCH_WORKFLOW } from "./workflow.js";

/**
 * Copies of the console read model's ladder shapes (`ArRunViewSchema` in the console app), not imports:
 * a package may not import an app. When the console schema changes, change these with it.
 */
const outcome = z.object({
  verdict: z.enum(["kept", "rejected", "stopped"]),
  reason: z.string(),
  rungReached: z.enum(["none", "L0", "L1", "L2", "L3"]),
  delta: z.number().optional(),
  sigma: z.number().optional(),
  head: z.string().optional(),
  branch: z.string().optional(),
  lesson: z.string().optional(),
  against: z.object({ sigma: z.number().nonnegative(), pairs: z.number().int().nonnegative(), locked: z.boolean().optional() }).optional(),
});
const implementer = z.object({ agent: z.string(), sessionId: z.string().optional(), resumedFrom: z.string().optional() });
const ladderFragment = z.object({
  implementer: implementer.nullable().default(null),
  l0: z.object({ ok: z.boolean(), code: z.string().optional() }).nullable(),
  micro: z.object({ predictedDirectionMet: z.boolean() }).nullable(),
  outcome: outcome.nullable(),
});

/** What a read model builds from one recorded `ar-stop` outcome. */
const fragmentOf = (recorded: Outcome) => ({
  implementer: recorded.implementer ?? null,
  l0: recorded.l0 ?? null,
  micro: recorded.micro ? { predictedDirectionMet: recorded.micro.predicted_direction_met } : null,
  outcome: recorded,
});

const hosts: TestHost[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  repos.splice(0).forEach(removeFixture);
});

describe("the console's ladder view from a recorded outcome", () => {
  it("fills the noise, implementer, L0 and micro fields the console reads", async () => {
    const policy = { ...FIXTURE_POLICY, mechanisms: { better: { metrics: { cc_total_delta_pct: -3 } } } };
    const repo = await fixtureRepo(policy);
    repos.push(repo);
    const host = openTestHost(fakeArPorts(repo, policy, { planner: scriptedPlanner(["better"]) }));
    hosts.push(host);
    const run = await host.runtime.wait(host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify({ lanes: 1, rounds: 1, minPool: 0 }) }));
    const recorded = stopOutcomes(run).get(ideaId(proposal("better")))!;

    const view = ladderFragment.parse(fragmentOf(recorded));

    expect(view.outcome!.against).toEqual({ sigma: recorded.against!.sigma, pairs: 3, locked: false });
    expect(view.implementer).toEqual({ agent: recorded.implementer!.agent, sessionId: recorded.implementer!.sessionId });
    expect(view.l0).toEqual({ ok: true });
    expect(view.micro).toEqual({ predictedDirectionMet: true });
  }, 60_000);
});
