import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { landPrWorkflow } from "../workflows/land-pr.js";
import type { ShepherdPhases } from "./phases.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";
import { configuredVisualSetCarry } from "./visual-accept.js";

const H2 = fakeSha("head2");
const dirs: string[] = [];
const hosts: FactoryHost[] = [];
afterEach(() => {
  hosts.splice(0).forEach((host) => host.close());
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
});

const setFlag = (configHome: string, mode: "off" | "on"): void => {
  mkdirSync(join(configHome, "titan-factory"), { recursive: true });
  writeFileSync(join(configHome, "titan-factory", "config.json"), JSON.stringify({ shepherd: { visualSetCarry: mode } }));
};

/** Host A parks with `inFlight` never answering; the flag is then turned on and host B adopts the run. */
async function parkedThenAdopted(inFlight: "sh-held-check" | "sh-repair") {
  const dir = mkdtempSync(join(tmpdir(), "visual-accept-adopt-"));
  dirs.push(dir);
  const configHome = join(dir, "config");
  setFlag(configHome, "off");
  const fake: FakeGitHub = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, pr.headSha === H1 ? [successRun("visual", 1, undefined, "failure")] : [successRun("visual", 9)]);
  fake.addPr({ headSha: H1 });
  const phases: ShepherdPhases = {
    review: async () => ({ kind: "none" }),
    wake: async () => (fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }),
    visualSetCarry: () => configuredVisualSetCarry({ XDG_CONFIG_HOME: configHome }),
  };
  const seat = { name: "ui", remotes: [REPO.toLowerCase()], paths: {}, grants: [], visualPaths: ["packages/ui/**"], visualBaselines: { check: "visual", paths: ["**/__screenshots__/**"] } };
  const store = shepherdStoreRef();
  let clock = 0;
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const routes = () => factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, seats: () => ({ seats: [seat], denied: [] }) });
  const open = (stuck: string | undefined) => {
    const all = routes();
    const hang = (route: (typeof all)[number]) => (route.match === stuck ? { ...route, runner: { run: () => new Promise<never>(() => undefined) } } : route);
    const wired = Object.assign(all.map(hang), { database: all.database, shepherd: all.shepherd });
    const host = openFactoryHost({ dbPath: join(dir, "state", "factory.sqlite3"), workflows: [shepherdPrWorkflow(phases), landPrWorkflow()], routes: stuck ? wired : all, gatePollMs: 5 });
    hosts.push(host);
    return host;
  };
  const first = open(inFlight);
  const runId = first.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  await vi.waitFor(() => expect(Object.keys(first.runtime.status(runId)?.activeSteps ?? {}).some((id) => id.startsWith(inFlight))).toBe(true));
  first.close();
  setFlag(configHome, "on");
  const second = open(undefined);
  await second.adopt();
  const steps = () => Object.values(second.runtime.status(runId)!.stepResults).map((result) => result.stepId);
  return { second, runId, steps };
}

describe.each([["sh-held-check" as const], ["sh-repair" as const]])("a flag turned on while %s was in flight on the old host", (inFlight) => {
  it("offers no visual accept and settles the recovered step as the flag-off record ran", async () => {
    const { second, runId, steps } = await parkedThenAdopted(inFlight);

    await vi.waitFor(() => expect(steps().some((stepId) => stepId.startsWith(inFlight))).toBe(true));

    expect(second.gates.get(gateId(runId, "sh-visual-accept"))).toBeUndefined();
    expect(steps().filter((stepId) => stepId.startsWith("sh-visual-accept"))).toEqual([]);
  });

  it("never reaches recovery_required, whichever way the run goes on", async () => {
    const { second, runId } = await parkedThenAdopted(inFlight);

    await vi.waitFor(() => expect(second.runtime.status(runId)?.activeSteps).toEqual({}));

    expect(second.runtime.status(runId)?.status).not.toBe("recovery_required");
  });

  it("ends an abandon at a later live round without replaying short of the recovered step", async () => {
    const { second, runId, steps } = await parkedThenAdopted(inFlight);
    await vi.waitFor(() => expect(steps().some((stepId) => stepId.startsWith(inFlight))).toBe(true));
    await gateOpened(second, gateId(runId, "sh-visual-accept"), 3000).catch(() => undefined);
    const gate = second.gates.get(gateId(runId, "sh-visual-accept"));

    if (gate) second.gates.resolve(gate.id, { decision: "abandon", headSha: H1 }, OWNER);
    await vi.waitFor(() => expect(second.runtime.status(runId)?.status).not.toBe("running"));

    expect(second.runtime.status(runId)?.error ?? "").not.toContain("replay never reached recovered step");
  });
});
