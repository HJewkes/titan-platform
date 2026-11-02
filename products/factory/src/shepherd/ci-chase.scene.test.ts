import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub, type GitHubPort } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, outsideActions } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import { mergeOrderGuard } from "./merge-order-guard.js";
import { MergeOrder, type MergeOrderRules } from "./merge-order.js";
import type { ShepherdPhases } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef, type ShepherdStore } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const X_HEAD = fakeSha("chase-x");
const X_FILES = ["products/widget/src/policy.ts"];
/** The first landed before X's green was read; each other one tries to land while X's CI runs. All change X's unit, never X's file. */
const SIBLINGS = ["products/widget/src/a.ts", "products/widget/src/b.ts", "products/widget/src/c.ts", "products/widget/src/d.ts"];
const DISJOINT = "apps/console/src/page.ts";
const order = (enabled: boolean): MergeOrderRules => () => ({ enabled, ttlMinutes: 1e9, ignore: [".changeset/**"] });

interface Chase {
  host: FactoryHost;
  fake: FakeGitHub;
  /** Every X head CI ran on, in order: one entry per full CI round. */
  ciHeads: string[];
  /** The merge-order reason each overlapping sibling read when it tried to land, or undefined when it landed. */
  siblingReasons: (string | undefined)[];
  run(): Promise<void>;
}

/**
 * tp#3149's r1 to r5 shape, on a repo with no strict rule: X's head is green, but a PR in X's unit landed first, so X
 * merges main in and its CI runs again. While that CI runs, the next PR in X's unit tries to land, and a disjoint PR lands.
 */
function chase(options: { orderOn: boolean; overlapping?: number }): Chase {
  const fake = fakeGitHub({ repo: REPO });
  fake.rules.strict = false;
  const x = fake.addPr({ headSha: X_HEAD }).number;
  fake.prFiles.set(x, X_FILES.map((path) => ({ path, status: "modified" as const })));
  const siblings = SIBLINGS.slice(1, 1 + (options.overlapping ?? SIBLINGS.length)).map((path, i) => sibling(fake, path, `sib-${i}`));
  const ciHeads: string[] = [];
  fake.onGetPr = (pr) => {
    fake.setRuns(pr.headSha, [outsideActions(successRun("validate", 11)), outsideActions(successRun("dag-check", 12))]);
    if (pr.number === x && !ciHeads.includes(pr.headSha)) ciHeads.push(pr.headSha);
  };
  land(fake, x, X_HEAD, [SIBLINGS[0]!]);
  let clock = 0;
  const store = shepherdStoreRef();
  const port = githubPort(fake.wire);
  const routes = factoryRoutesFor({ port: chasedPort(port, () => world), store, now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)), holdPollMs: 1, mergeOrderRules: order(options.orderOn) });
  const phases: ShepherdPhases = { wake: async () => ({ kind: "unhandled", reason: "no agent in this scene" }), review: async () => ({ kind: "none" }) };
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  const guard = mergeOrderGuard({ order: () => new MergeOrder(host.db), registrations: () => store.get(), rules: order(options.orderOn), now: () => clock });
  siblings.forEach((pr) => store.get().register({ repo: REPO, pr, runId: `run-${pr}`, task: `demo/${pr}`, implementer: `impl-${pr}`, policy: OWNER_GATE_POLICY }));
  const world: World = { fake, x, port, guard, store: store.get(), queue: [...siblings], siblingReasons: [] };
  return { host, fake, ciHeads, siblingReasons: world.siblingReasons, run: () => shepherdX(host, fake, x) };
}

interface World {
  fake: FakeGitHub;
  x: number;
  port: GitHubPort;
  guard: ReturnType<typeof mergeOrderGuard>;
  store: ShepherdStore;
  queue: number[];
  siblingReasons: (string | undefined)[];
}

function sibling(fake: FakeGitHub, path: string, tag: string): number {
  const pr = fake.addPr({ headSha: fakeSha(tag), mergeSha: fakeSha(`${tag}-merge`) }).number;
  fake.prFiles.set(pr, [{ path, status: "added" as const }]);
  return pr;
}

/** Main moves by `files`; X's head is behind, and main's delta since that head's fork names every file landed since. */
function land(fake: FakeGitHub, x: number, head: string, files: string[]): void {
  const key = `${head}...main`;
  const delta = fake.compares.get(key)?.files ?? [];
  fake.refs.set("main", fakeSha(`main-${head}-${delta.length + files.length}`));
  fake.compares.set(key, { mergeBaseSha: fakeSha("fork"), files: [...delta, ...files] });
  fake.pr(x).behind = true;
}

/** After each update of X, the next sibling in X's unit lands unless the merge order holds it, then a disjoint PR lands. */
function chasedPort(port: GitHubPort, world: () => World): GitHubPort {
  return {
    ...port,
    updateBranch: async (repo, pr, expected) => {
      const result = await port.updateBranch(repo, pr, expected);
      const { fake, x } = world();
      const head = fake.pr(x).headSha;
      await nextSibling(world(), head);
      land(fake, x, head, [DISJOINT]);
      return result;
    },
  };
}

async function nextSibling(world: World, xHead: string): Promise<void> {
  const pr = world.queue[0];
  if (pr === undefined) return;
  const read = world.fake.pr(pr);
  const reason = await world.guard.reason(world.port, REPO, pr, "main", read.headSha, read.headRef);
  world.siblingReasons.push(reason);
  if (reason !== undefined) return;
  world.queue.shift();
  Object.assign(read, { state: "closed", merged: true });
  land(world.fake, world.x, xHead, (await world.port.listPrFiles(REPO, pr)).map((file) => file.path));
}

async function shepherdX(host: FactoryHost, fake: FakeGitHub, x: number): Promise<void> {
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(x), policy: JSON.stringify(OWNER_GATE_POLICY) });
  await expect
    .poll(
      () => {
        const asked = host.pendingGates().some((gate) => gate.runId === runId && gate.gate.id.includes("approve-merge"));
        if (asked) host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: fake.pr(x).headSha }, OWNER);
        return fake.pr(x).merged;
      },
      { timeout: 10_000, interval: 10 },
    )
    .toBe(true);
  host.runtime.cancel(runId, "scene done");
}

describe("a green PR whose base moves while its CI runs (tp#3149, tp#2241)", () => {
  it("reserves its unit at the first overlap and lands on its next green, in at most 2 CI rounds", async () => {
    const world = chase({ orderOn: true });

    await world.run();

    expect(world.ciHeads.length).toBeLessThanOrEqual(2);
    expect(world.fake.effects.updateBranch).toBe(1);
    expect(world.fake.pr(1)).toMatchObject({ merged: true, headSha: world.ciHeads[1] });
    expect(world.siblingReasons[0]).toMatch(/merge order: waiting behind #1 \(products\/widget\//);
  });

  it("lands a rerun's green as it stands when main moved since only by disjoint commits", async () => {
    const world = chase({ orderOn: true, overlapping: 0 });

    await world.run();

    expect(world.ciHeads).toHaveLength(2);
    expect(world.fake.effects.updateBranch).toBe(1);
    expect(world.fake.pr(1).headSha).toBe(world.ciHeads[1]);
  });

  it("never lands a green whose base a PR in its unit moved: it merges main in again", async () => {
    const world = chase({ orderOn: false, overlapping: 1 });

    await world.run();

    expect(world.siblingReasons).toEqual([undefined]);
    expect(world.fake.effects.updateBranch).toBe(2);
    expect(world.fake.pr(1)).toMatchObject({ merged: true, headSha: world.ciHeads[2] });
  });
});
