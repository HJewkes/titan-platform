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

type Flag = "off" | "on";

const setFlag = (configHome: string, mode: Flag): void => {
  mkdirSync(join(configHome, "titan-factory"), { recursive: true });
  writeFileSync(join(configHome, "titan-factory", "config.json"), JSON.stringify({ shepherd: { visualSetCarry: mode } }));
};

/** H1 is red only on the seat's baseline check; the fixer's push makes H2, which is green. */
function shepherdWorld(flag: Flag) {
  const dir = mkdtempSync(join(tmpdir(), "visual-accept-adopt-"));
  dirs.push(dir);
  const configHome = join(dir, "config");
  setFlag(configHome, flag);
  const fake: FakeGitHub = fakeGitHub();
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, pr.headSha === H1 ? [successRun("visual", 1, undefined, "failure")] : [successRun("validate", 7), successRun("dag-check", 8), successRun("visual", 9)]);
  fake.addPr({ headSha: H1 });
  let wakes = 0;
  const phases: ShepherdPhases = {
    review: async () => ({ kind: "none" }),
    wake: async () => (wakes++, fake.pushHead(1, H2), { kind: "woken", agent: "impl-a" }),
    visualSetCarry: () => configuredVisualSetCarry({ XDG_CONFIG_HOME: configHome }),
  };
  const seat = { name: "ui", remotes: [REPO.toLowerCase()], paths: {}, grants: [], visualPaths: ["packages/ui/**"], visualBaselines: { check: "visual", paths: ["**/__screenshots__/**"] } };
  const store = shepherdStoreRef();
  let clock = 0;
  const tick = async (ms: number, signal: AbortSignal) => ((clock += ms), sleep(1, signal));
  const routes = () => factoryRoutesFor({ port: githubPort(fake.wire), store, now: () => clock, sleep: tick, seats: () => ({ seats: [seat], denied: [] }) });
  const open = (stuck?: string) => {
    const all = routes();
    const hang = (route: (typeof all)[number]) => (route.match === stuck ? { ...route, runner: { run: () => new Promise<never>(() => undefined) } } : route);
    const wired = Object.assign(all.map(hang), { database: all.database, shepherd: all.shepherd });
    const host = openFactoryHost({ dbPath: join(dir, "state", "factory.sqlite3"), workflows: [shepherdPrWorkflow(phases), landPrWorkflow()], routes: stuck ? wired : all, gatePollMs: 5 });
    hosts.push(host);
    return host;
  };
  const start = (host: FactoryHost) => {
    const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
    store.get().register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
    return runId;
  };
  return { configHome, open, start, wakes: () => wakes };
}

/** Host A parks with `inFlight` never answering; the flag is then set to `adoptFlag` and host B adopts the run. */
async function parkedThenAdopted(inFlight: string, recordFlag: Flag, adoptFlag: Flag) {
  const world = shepherdWorld(recordFlag);
  const first = world.open(inFlight);
  const runId = world.start(first);
  await vi.waitFor(() => expect(Object.keys(first.runtime.status(runId)?.activeSteps ?? {}).some((id) => id.startsWith(inFlight))).toBe(true));
  first.close();
  setFlag(world.configHome, adoptFlag);
  const second = world.open();
  await second.adopt();
  const steps = () => Object.values(second.runtime.status(runId)!.stepResults).map((result) => result.stepId);
  return { world, second, runId, steps };
}

describe("a flag turned on while sh-held-check was in flight on the old host", () => {
  const inFlight = "sh-held-check";
  const adopted = () => parkedThenAdopted(inFlight, "off", "on");

  it("offers no visual accept and settles the recovered step as the flag-off record ran", async () => {
    const { second, runId, steps } = await adopted();

    await vi.waitFor(() => expect(steps().some((stepId) => stepId.startsWith(inFlight))).toBe(true));

    expect(second.gates.get(gateId(runId, "sh-visual-accept"))).toBeUndefined();
    expect(steps().filter((stepId) => stepId.startsWith("sh-visual-accept"))).toEqual([]);
  });

  it("never reaches recovery_required, whichever way the run goes on", async () => {
    const { second, runId } = await adopted();

    await vi.waitFor(() => expect(second.runtime.status(runId)?.activeSteps).toEqual({}));

    expect(second.runtime.status(runId)?.status).not.toBe("recovery_required");
  });

  const answers = {
    abandon: { answer: { decision: "abandon", headSha: H1 }, settles: { status: "completed", currentStep: "sh-stopped" } },
    "accept-set": {
      answer: { decision: "accept-set", headSha: H1, approvedSet: { fromHead: H1, files: [{ path: "packages/ui/__screenshots__/a.png" }] }, note: "take these" },
      settles: { status: "paused", currentStep: "approve-merge" },
    },
    "send-back": { answer: { decision: "send-back", headSha: H1, note: "not these" }, settles: { status: "paused", currentStep: "approve-merge" } },
  } as const;

  it.each(Object.entries(answers))("replays a %s at the later live offer on a third host without recovery_required", async (_decision, { answer, settles }) => {
    const { world, second, runId, steps } = await adopted();
    await gateOpened(second, gateId(runId, "sh-visual-accept"), 10_000);
    expect(steps().some((stepId) => stepId.startsWith(inFlight))).toBe(true);
    const answeredAt = steps().length;
    second.gates.resolve(gateId(runId, "sh-visual-accept"), answer, OWNER);
    await vi.waitFor(() => expect(steps().length).toBeGreaterThan(answeredAt + 1));
    second.close();

    const third = world.open();
    await third.adopt();
    await vi.waitFor(() => expect(third.runtime.status(runId)?.status).not.toBe("running"));

    expect(third.runtime.status(runId)).toMatchObject(settles);
  }, 30_000);
});

describe("the flag on throughout and the offer itself in flight on the old host", () => {
  it("claims the recovered offer and asks the owner at the red head instead of waking the fixer", async () => {
    const { world, second, runId } = await parkedThenAdopted("sh-visual-accept-offer", "on", "on");

    await gateOpened(second, gateId(runId, "sh-visual-accept"), 10_000);

    expect(second.gates.get(gateId(runId, "sh-visual-accept"))?.prompt).toContain(`at head ${H1}`);
    expect(second.runtime.status(runId)?.activeSteps).toEqual({});
    expect(world.wakes()).toBe(0);
  });
});
