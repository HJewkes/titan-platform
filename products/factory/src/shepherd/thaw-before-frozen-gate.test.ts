import { fakeGitHub, fakeSha, githubPort, successRun, type GitHubPort } from "@titan-design/github";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { freezeStoreRef } from "./freeze.js";
import { shepherdPrWorkflow } from "./pr.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { shepherdStoreRef } from "./store.js";
import { closeThawedMainGates } from "./thawed-main-gates.js";

const RED_SHA = fakeSha("earlier-red");
const GREEN_TIP = fakeSha("green-tip");

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/**
 * PR 1 merges green, but another run's red at an older sha freezes the repo while this run waits on main CI. The merge
 * does not descend from that red sha, so sh-unfreeze leaves the freeze in place. `thawDuringUnfreeze` thaws the episode
 * from elsewhere while sh-unfreeze is still reading GitHub, as the main watch did on 2026-10-31.
 */
function frozenElsewhereWorld({ thawDuringUnfreeze }: { thawDuringUnfreeze: boolean }) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, [successRun("validate", 1), successRun("dag-check", 2)]);
  const base = githubPort(fake.wire);
  let clock = 0;
  const freeze = freezeStoreRef(() => clock);
  let frozeElsewhere = false;
  const freezeOnce = () => {
    if (!frozeElsewhere) freeze.get().freeze(REPO, RED_SHA);
    frozeElsewhere = true;
  };
  const port: GitHubPort = {
    ...base,
    checkRuns: async (repo, sha) => {
      if (sha === fake.pr(1).mergeSha) {
        freezeOnce();
        fake.setRuns(sha, [successRun("validate", 5), successRun("dag-check", 6)]);
      }
      return base.checkRuns(repo, sha);
    },
    compareFiles: async (repo, from, to) => {
      if (from !== RED_SHA) return base.compareFiles(repo, from, to);
      if (thawDuringUnfreeze) freeze.get().unfreeze(REPO, GREEN_TIP);
      return { mergeBaseSha: fakeSha("older"), files: [], truncated: false };
    },
  };
  const store = shepherdStoreRef();
  const routes = factoryRoutesFor({ port, store, freeze, now: () => clock, sleep: async (ms, signal) => (signal.throwIfAborted(), void (clock += ms)) });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, routes, store, freezes: () => freeze.get() };
}

type World = ReturnType<typeof frozenElsewhereWorld>;

async function runToMerge(w: World): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  w.store.get().register({ repo: REPO, pr: 1, runId, task: "demo/TP-1", implementer: "impl-a", policy: OWNER_GATE_POLICY });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  return runId;
}

const stepIds = (w: World, runId: string): string[] => Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);
const ENDED: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"]);

/** Returns once the run has ended or opened its main-frozen gate, so a gate that should not open fails fast instead of hanging. */
async function endedOrAsked(w: World, runId: string): Promise<void> {
  const asked = () => w.host.gates.get(gateId(runId, "main-frozen")) !== undefined;
  await vi.waitFor(() => expect(asked() || ENDED.has(w.host.runtime.status(runId)!.status)).toBe(true));
}

const pendingFrozenGates = (w: World) => w.host.pendingGates().filter(({ gate }) => gate.id.endsWith("/main-frozen"));

describe("a merged run whose repo another run froze and something else thawed", () => {
  it("opens no main-frozen gate when the episode thaws while sh-unfreeze reads main, and completes", async () => {
    const w = frozenElsewhereWorld({ thawDuringUnfreeze: true });
    const runId = await runToMerge(w);

    await endedOrAsked(w, runId);

    expect(w.host.gates.get(gateId(runId, "main-frozen"))).toBeUndefined();
    expect(pendingFrozenGates(w)).toEqual([]);
    expect(w.host.runtime.status(runId)!.status).toBe("completed");
    expect(stepIds(w, runId)).toEqual(expect.arrayContaining(["sh-unfreeze", "sh-cleanup"]));
    expect(stepIds(w, runId)).not.toContain("sh-thaw");
  });

  it("cancels the main-frozen gate once the episode thaws after it opened, and completes", async () => {
    const w = frozenElsewhereWorld({ thawDuringUnfreeze: false });
    const runId = await runToMerge(w);
    await gateOpened(w.host, gateId(runId, "main-frozen"));
    w.freezes().unfreeze(REPO, GREEN_TIP);

    const closed = closeThawedMainGates(w.host, w.routes.shepherd!);
    await w.host.runtime.wait(runId);

    expect(closed).toEqual([{ runId, gateId: gateId(runId, "main-frozen"), episode: 1 }]);
    expect(pendingFrozenGates(w)).toEqual([]);
    expect(w.host.runtime.status(runId)!.status).toBe("completed");
    expect(stepIds(w, runId)).toContain("sh-cleanup");
  });
});
