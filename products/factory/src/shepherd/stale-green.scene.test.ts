import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { REPO, outsideActions } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { sleep } from "../workflows/land.js";
import type { ShepherdPhases, WakeRequest } from "./phases.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdPrWorkflow } from "./pr.js";
import { sharedWithMain } from "./stale-green.js";
import { shepherdStoreRef } from "./store.js";

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

const MOVER = 1;
const IMPORTER = 2;
const MOVER_HEAD = fakeSha("mover");
const IMPORTER_HEAD = fakeSha("importer");
const MOVED_SYMBOL = ["products/widget/src/policy.ts", "products/widget/src/policy-schema.ts"];
const NEW_IMPORTER = "products/widget/src/rate-limit.test.ts";

const checks = (validate: "success" | "failure") => [outsideActions(successRun("validate", 11, undefined, validate)), outsideActions(successRun("dag-check", 12))];

interface Scene {
  host: FactoryHost;
  fake: FakeGitHub;
  wakes: WakeRequest[];
  /** Shepherds the importer's PR, signing off each merge the owner gate asks about, until it merges or a wake ends the wait. */
  shepherdSecond(): Promise<void>;
}

/**
 * Both heads went green at one main tip on a repo with no strict rule; the mover then landed. `breaksTogether` is the typecheck
 * of a head holding both PRs: only a head with main merged in can fail it, as only that head's CI saw both.
 */
function scene(options: { importerFiles?: string[]; mainDelta?: string[]; breaksTogether?: boolean; moverLanded?: boolean } = {}): Scene {
  const fake = fakeGitHub();
  fake.rules.strict = false;
  fake.addPr({ headSha: MOVER_HEAD });
  fake.addPr({ headSha: IMPORTER_HEAD });
  const merged = () => fake.pr(IMPORTER).headSha !== IMPORTER_HEAD;
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, checks(pr.number === IMPORTER && merged() && options.breaksTogether === true ? "failure" : "success"));
  fake.prFiles.set(IMPORTER, (options.importerFiles ?? [NEW_IMPORTER]).map((path) => ({ path, status: "added", additions: 1, deletions: 0 })));
  if (options.moverLanded !== false) moverLands(fake, options.mainDelta ?? MOVED_SYMBOL);
  const wakes: WakeRequest[] = [];
  const phases: ShepherdPhases = { wake: async (_ctx, request) => (wakes.push(request), { kind: "unhandled", reason: "no agent in this scene" }), review: async () => ({ kind: "none" }) };
  let clock = 0;
  const routes = factoryRoutesFor({ port: githubPort(fake.wire), store: shepherdStoreRef(), now: () => clock, sleep: async (ms, signal) => ((clock += ms), sleep(1, signal)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow(phases)], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, wakes, shepherdSecond: () => shepherdSecond(host, fake, wakes) };
}

function moverLands(fake: FakeGitHub, delta: string[]): void {
  const pr = fake.pr(MOVER);
  const tip = fakeSha("main-with-mover");
  Object.assign(pr, { state: "closed", merged: true, mergeSha: tip });
  fake.refs.set("main", tip);
  fake.pr(IMPORTER).behind = true;
  fake.compares.set(`${IMPORTER_HEAD}...main`, { mergeBaseSha: fakeSha("green-tip"), files: delta });
}

async function shepherdSecond(host: FactoryHost, fake: FakeGitHub, wakes: WakeRequest[]): Promise<void> {
  const runId = host.runtime.start("shepherd-pr", { repo: REPO, pr: String(IMPORTER), policy: JSON.stringify(OWNER_GATE_POLICY) });
  await expect
    .poll(
      () => {
        const asked = host.pendingGates().some((gate) => gate.runId === runId && gate.gate.id.includes("approve-merge"));
        if (asked) host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: fake.pr(IMPORTER).headSha }, OWNER);
        return fake.pr(IMPORTER).merged || wakes.length > 0;
      },
      { timeout: 10_000, interval: 10 },
    )
    .toBe(true);
  host.runtime.cancel(runId, "scene done");
}

describe("two PRs green at one main tip, the second importing a symbol the first moved", () => {
  it("never lands the second on its stale green: the typecheck runs on the merge and its red stays off main", async () => {
    const world = scene({ breaksTogether: true });

    await world.shepherdSecond();

    expect(world.fake.pr(IMPORTER).merged).toBe(false);
    expect(world.fake.effects.merge).toBe(0);
    expect(world.fake.effects.updateBranch).toBe(1);
    expect(world.wakes[0]).toMatchObject({ kind: "ci-red", headSha: world.fake.pr(IMPORTER).headSha });
    expect(world.wakes[0]?.headSha).not.toBe(IMPORTER_HEAD);
  });

  it("lands the second on the merged head once its required checks pass there", async () => {
    const world = scene();

    await world.shepherdSecond();

    const pr = world.fake.pr(IMPORTER);
    expect(pr.merged).toBe(true);
    expect(pr.headSha).not.toBe(IMPORTER_HEAD);
    expect(world.fake.effects.updateBranch).toBe(1);
  });

  it("re-checks when main's delta cannot be read, rather than landing unjudged", async () => {
    const world = scene({ breaksTogether: true });
    world.fake.wire.compareFiles = async () => {
      throw new Error("compare unavailable");
    };

    await world.shepherdSecond();

    expect(world.fake.pr(IMPORTER).merged).toBe(false);
    expect(world.fake.effects.updateBranch).toBe(1);
  });
});

describe("green heads the moved base cannot break land with no extra CI", () => {
  it("lands a disjoint pair's second PR at its own head", async () => {
    const world = scene({ importerFiles: ["apps/console/src/page.ts"] });

    await world.shepherdSecond();

    expect(world.fake.pr(IMPORTER)).toMatchObject({ merged: true, headSha: IMPORTER_HEAD });
    expect(world.fake.effects.updateBranch).toBe(0);
  });

  it("lands a lone PR on an unmoved main at its own head", async () => {
    const world = scene({ moverLanded: false });

    await world.shepherdSecond();

    expect(world.fake.pr(IMPORTER)).toMatchObject({ merged: true, headSha: IMPORTER_HEAD });
    expect(world.fake.effects.updateBranch).toBe(0);
  });
});

describe("what main's delta shares with a PR", () => {
  it("names a unit both sides changed", () => {
    expect(sharedWithMain([NEW_IMPORTER], MOVED_SYMBOL)).toEqual(["products/widget/"]);
  });

  it("names root build config main changed, whatever units the PR touches", () => {
    expect(sharedWithMain([NEW_IMPORTER], ["tsconfig.base.json"])).toEqual(["tsconfig.base.json"]);
  });

  it("ignores markdown, so a release's CHANGELOG rewrite shares nothing with a PR", () => {
    expect(sharedWithMain(["products/widget/README.md"], ["products/widget/CHANGELOG.md"])).toEqual([]);
    expect(sharedWithMain([NEW_IMPORTER], ["products/widget/CHANGELOG.md", ".changeset/note.md", "site/guide.md"])).toEqual([]);
  });
});
