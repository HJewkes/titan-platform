import { afterEach, describe, expect, it } from "vitest";
import { fakeArPorts, FIXTURE_POLICY, fixtureRepo, removeFixture, scriptedPlanner, type FakeOptions, type FixtureRepo, type Policy } from "./test-support/fake-ports.js";
import { openTestHost, type TestHost } from "./test-support/host.js";
import { AUTORESEARCH_VALIDATE_WORKFLOW } from "./validate.js";
import { AUTORESEARCH_WORKFLOW } from "./workflow.js";

const POLICY: Policy = { ...FIXTURE_POLICY, mechanisms: { better: { metrics: { cc_total_delta_pct: -3 } } } };

const hosts: TestHost[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  repos.splice(0).forEach(removeFixture);
});

async function world(options: Partial<FakeOptions> = {}) {
  const repo = await fixtureRepo(POLICY);
  repos.push(repo);
  const ports = fakeArPorts(repo, POLICY, { planner: scriptedPlanner(["better"]), ...options });
  const host = openTestHost(ports);
  hosts.push(host);
  return { repo, ports, host };
}

const lookParams = (parent: string, pin: string, look = 1) => ({ parent, pin, head: pin, look: String(look), frozenHash: "f".repeat(64) });

describe("a validator look", () => {
  it("records the look's aggregate on its own run and hands the port the parent's pin", async () => {
    const { repo, ports, host } = await world();

    const look = await host.runtime.wait(host.runtime.start(AUTORESEARCH_VALIDATE_WORKFLOW, lookParams("run-parent", repo.pin, 2)));

    expect(look.status).toBe("completed");
    expect(ports.calls.looks).toEqual([{ runId: "run-parent", pin: repo.pin, frozenHash: "f".repeat(64), look: 2, head: repo.pin }]);
    expect(Object.keys(look.stepResults)).toEqual(["ar-validate:2:0"]);
  });

  it("fails the step when the validator answers with a per-case key", async () => {
    const validate: FakeOptions["validate"] = (input) => {
      const answer = {
        look: input.look, at: "2026-10-21T00:00:00.000Z", sha: input.head, provenance: "fixture", usd: 0,
        aggregate: { metrics: { cc_total_delta_pct: -1 }, gates: { all_gate: 3 } },
        perCase: { "val-1": { cc_total_delta_pct: -1 } },
      };
      return answer;
    };
    const { repo, host } = await world({ validate });

    const look = await host.runtime.wait(host.runtime.start(AUTORESEARCH_VALIDATE_WORKFLOW, lookParams("run-parent", repo.pin)));

    expect(look.status).toBe("failed");
    expect(look.stepResults["ar-validate:1:0"]).toBeUndefined();
  });

  it("never plans and never writes to the parent run", async () => {
    const { repo, ports, host } = await world();
    const parent = await host.runtime.wait(host.runtime.start(AUTORESEARCH_WORKFLOW, { pin: repo.pin, config: JSON.stringify({ lanes: 1, rounds: 1, minPool: 0 }) }));
    const plansBefore = ports.calls.plans.length;

    const look = await host.runtime.wait(host.runtime.start(AUTORESEARCH_VALIDATE_WORKFLOW, lookParams(parent.id, repo.pin)));

    expect(look.status).toBe("completed");
    expect(Object.keys(look.stepResults).filter((key) => !key.startsWith("ar-validate:"))).toEqual([]);
    expect(ports.calls.plans).toHaveLength(plansBefore);
    expect(host.runtime.status(parent.id)!.stepResults).toEqual(parent.stepResults);
  });
});
