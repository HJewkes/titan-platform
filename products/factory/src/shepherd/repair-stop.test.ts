import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { openDatabase, runMigrations } from "@titan-design/store-sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO } from "../test-support/land.js";
import { SHEPHERD_MIGRATIONS, factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { appendEvent } from "./events.js";
import type { ExitNoticePorts } from "./exit-notice.js";
import type { ShepherdPhases, Verdict, WakeOutcome, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY, type EffectivePolicy } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { ShepherdStore, shepherdStoreRef } from "./store.js";

const H2 = fakeSha("stopped-fix");
const AUTO: EffectivePolicy = { ...OWNER_GATE_POLICY, merge: "auto", fixer: true, seat: "demo-seat" };
const G10_ADVERSARY = "g10-adversary: packages/tool-guard touch";
const RUN_STOP = { repo: REPO, scope: "#1" };
const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

interface Stopped {
  host: FactoryHost;
  fake: FakeGitHub;
  store: ShepherdStore;
  runId: string;
  wakes: WakeRequest[];
  sent: string[];
}

interface StoppedOptions {
  hold?: string;
  /** Set before the run's first wake, as a seat's stop is. */
  stop?: string;
  files?: string[];
  passes?: (headSha: string) => boolean;
  /** What the fixer does when woken; absent means it pushes H2. */
  fix?: (w: Stopped, request: WakeRequest) => WakeOutcome;
}

const merge = (headSha: string): Verdict => ({ kind: "MERGE", headSha, evidence: {} });

function pushH2(w: Stopped): WakeOutcome {
  w.fake.pushHead(1, H2);
  return { kind: "woken", agent: "impl-a", sessionId: "s-fixer" };
}

/** Each wake hands the fixer the world it runs in, so a fixer can push or set a stop as a seat would mid-run. */
function stoppedRun(options: StoppedOptions = {}): Stopped {
  const [fake, ref, wakes, sent]: [FakeGitHub, ReturnType<typeof shepherdStoreRef>, WakeRequest[], string[]] = [fakeGitHub(), shepherdStoreRef(), [], []];
  const passes = options.passes ?? ((headSha: string) => headSha !== H1);
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1, undefined, passes(pr.headSha) ? "success" : "failure"), successRun("dag-check", 2)]);
  const late: { world?: Stopped } = {};
  const shepherd: ShepherdPhases = {
    wake: async (_ctx, request) => (wakes.push(request), (options.fix ?? pushH2)(late.world!, request)),
    review: async (_ctx, request) => merge(request.headSha),
  };
  const ports: ExitNoticePorts = { seatFor: () => "book-seat", lastReport: async () => undefined, send: async (_seat, text) => void sent.push(text) };
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: ref, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), exitNotice: ports, park: async () => ({ lines: [] }), heldRepair: "on" });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(shepherd)], routes, gatePollMs: 5 });
  hosts.push(host);
  fake.addPr({ headSha: H1, mergeSha: fakeSha("test-merge"), mergeableState: "clean" });
  fake.prFiles.set(1, (options.files ?? ["packages/tool-guard/src/lex.ts"]).map((path) => ({ path, status: "modified" })));
  const store = ref.get();
  if (options.stop) store.repairStops().set({ repo: REPO, scope: options.stop }, "the owner's tool-guard freeze", { actor: "demo-seat" });
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(AUTO) });
  store.register({ repo: REPO, pr: 1, runId, task: "demo/1", implementer: "impl-a", policy: AUTO });
  if (options.hold) store.hold(runId, options.hold);
  late.world = { host, fake, store, runId, wakes, sent };
  return late.world;
}

const currentStep = (w: Stopped): string => w.host.runtime.status(w.runId)?.currentStep ?? "";
const ticksPast = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function restsAt(w: Stopped, step: RegExp): Promise<void> {
  await vi.waitFor(() => expect(currentStep(w)).toMatch(step), { timeout: 5_000 });
  await ticksPast(200);
}

describe("a seat's repair stop wakes no fixer, held or not (TP-3500)", () => {
  it("a g10-adversary hold under heldRepair on wakes no ci-red fixer while the run is stopped, and tells the seat once (Q22)", async () => {
    const w = stoppedRun({ hold: G10_ADVERSARY, stop: "#1" });

    await restsAt(w, /^sh-held-wait/);

    expect(w.wakes).toEqual([]);
    expect(w.fake.pr(1).headSha).toBe(H1);
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toContain("repair stop #1");
  });

  it("a fixer the seat killed and then stopped is not resumed by the next ci-red wake (Q23)", async () => {
    const killedThenStopped = (w: Stopped): WakeOutcome => {
      w.store.repairStops().set(RUN_STOP, "SIGTERMed the fixer during the owner's freeze", { actor: "demo-seat" });
      return pushH2(w);
    };
    const w = stoppedRun({ hold: G10_ADVERSARY, fix: killedThenStopped, passes: () => false });

    await restsAt(w, /^sh-held-wait/);

    expect(w.wakes.map((wake) => [wake.kind, wake.headSha])).toEqual([["ci-red", H1]]);
    expect(w.fake.pr(1).headSha).toBe(H2);
  });

  it("a stop on a path glob wakes no fixer for a PR that touches it", async () => {
    const w = stoppedRun({ stop: "packages/tool-guard/**" });

    await restsAt(w, /^sh-held-wait/);

    expect(w.wakes).toEqual([]);
  });

  it("a stop on a path glob leaves a PR outside it repairing as before", async () => {
    const w = stoppedRun({ stop: "packages/tool-guard/**", files: ["products/factory/src/serve.ts"] });

    await vi.waitFor(() => expect(w.wakes).toHaveLength(1), { timeout: 5_000 });

    expect(w.wakes[0]).toMatchObject({ kind: "ci-red", headSha: H1 });
  });

  it("clearing the stop lets the waiting run's next wake repair as before", async () => {
    const w = stoppedRun({ hold: G10_ADVERSARY, stop: "#1" });
    await restsAt(w, /^sh-held-wait/);

    expect(w.store.repairStops().clear(RUN_STOP, { actor: "demo-seat" })).toBe(true);
    await vi.waitFor(() => expect(w.wakes).toHaveLength(1), { timeout: 5_000 });

    expect(w.wakes[0]).toMatchObject({ kind: "ci-red", headSha: H1 });
    expect(w.store.byRun(w.runId)).toMatchObject({ held: true, holdReason: G10_ADVERSARY });
  });
});

describe("the repair stop history", () => {
  it("records setting and clearing a run's stop where shepherd timeline reads it", () => {
    const w = stoppedRun();
    const target = { ...RUN_STOP, runId: w.runId };

    w.store.repairStops().set(target, "owner freeze", { actor: "demo-seat" });
    w.store.repairStops().clear(target, { actor: "demo-seat" });

    expect(w.store.eventsOf(w.runId).map((event) => [event.kind, event.reason, event.actor])).toEqual([
      ["repair-stop", "#1: owner freeze", "demo-seat"],
      ["repair-go", "#1: cleared", "demo-seat"],
    ]);
  });

  it("shows a path stop on every run of its repo", () => {
    const w = stoppedRun({ stop: "packages/tool-guard/**" });

    expect(w.store.eventsOf(w.runId)).toEqual([expect.objectContaining({ kind: "repair-stop", runId: null, pr: null, reason: "packages/tool-guard/**: the owner's tool-guard freeze" })]);
  });
});

describe("the repair stop migration on a store from before it", () => {
  it("keeps every earlier event, its id and reclass mark, and then takes repair stops", () => {
    const db = openDatabase(":memory:");
    runMigrations(db, SHEPHERD_MIGRATIONS.filter((migration) => migration.version < 31));
    appendEvent(db, { runId: "run-old", repo: REPO, pr: 1, kind: "release", reason: "g10-review: old", actor: "shepherd", at: "2026-10-01T00:00:00.000Z", reclass: true });

    runMigrations(db, SHEPHERD_MIGRATIONS);
    const store = new ShepherdStore(db);
    store.register({ repo: REPO, pr: 1, runId: "run-old", task: "demo/1", implementer: "impl-a", policy: AUTO });
    store.repairStops().set({ ...RUN_STOP, runId: "run-old" }, "owner freeze", { actor: "demo-seat" });

    expect(store.eventsOf("run-old").map((event) => [event.kind, event.reclass ?? false])).toEqual([["release", true], ["repair-stop", false]]);
    expect(store.repairStops().list(REPO)).toEqual([expect.objectContaining({ scope: "#1", reason: "owner freeze", actor: "demo-seat" })]);
    db.close();
  });
});
