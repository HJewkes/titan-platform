import { tmpdir } from "node:os";
import { fakeGitHub, fakeSha, githubPort, successRun, type FakeGitHub } from "@titan-design/github";
import { afterEach, describe, expect, it } from "vitest";
import { openFactoryHost, type FactoryHost } from "../host.js";
import { H1, REPO, gateId, gateOpened } from "../test-support/land.js";
import { OWNER } from "../test-support/resolver.js";
import { factoryRoutesFor } from "../workflows.js";
import { freezeStoreRef } from "./freeze.js";
import type { MainRedWiring } from "./main-red.js";
import { OWNER_GATE_POLICY } from "./policy.js";
import { readMainCi, SH_MAIN_CI_TIMEOUT_MS, type MainCiInput } from "./post-merge.js";
import { shepherdPrWorkflow } from "./pr.js";
import { shepherdStoreRef } from "./store.js";

type Run = ReturnType<typeof successRun>;

const MERGE = fakeSha("red-merge");
const GREEN = fakeSha("green-descendant");
const TIP = fakeSha("running-tip");
const red = (name: string, id: number): Run => successRun(name, id, undefined, "failure");
const running = (name: string, id: number): Run => ({ ...successRun(name, id), status: "in_progress", conclusion: null });
const requiredGreen = (id: number): Run[] => [successRun("validate", id), successRun("dag-check", id + 1)];

interface MainLine {
  mergeRuns: Run[];
  greenRuns: Run[];
  /** The merge base compare reads for `merge...green` and `green...tip`; each defaults to the older commit, so the line is linear. */
  greenBase?: string;
  tipBase?: string;
}

/** Main moved past the merge to GREEN, then to TIP, whose run is still going; the required contexts are validate and dag-check. */
function mainLine(fake: FakeGitHub, merge: string, line: MainLine): void {
  fake.setRuns(merge, line.mergeRuns);
  fake.refs.set("main", TIP);
  fake.history = [
    { sha: TIP, message: "tip (#3)", committedAt: "2026-10-25T11:20:00Z" },
    { sha: GREEN, message: "green (#2)", committedAt: "2026-10-25T11:00:00Z" },
    { sha: merge, message: "merge (#1)", committedAt: "2026-10-25T10:40:00Z" },
  ];
  fake.compares.set(`${merge}...${GREEN}`, { mergeBaseSha: line.greenBase ?? merge, files: [] });
  fake.compares.set(`${GREEN}...${TIP}`, { mergeBaseSha: line.tipBase ?? GREEN, files: [] });
  fake.compares.set(`${merge}...${TIP}`, { mergeBaseSha: merge, files: [] });
  fake.setRuns(GREEN, line.greenRuns);
  fake.setRuns(TIP, [running("validate", 90), running("dag-check", 91)]);
}

function clockedTiming() {
  let clock = 0;
  return { now: () => clock, sleep: async (ms: number) => void (clock += ms), pollMs: 30_000, timeoutMs: SH_MAIN_CI_TIMEOUT_MS };
}

const input: MainCiInput = { repo: REPO, pr: 1, baseRef: "main", mergeSha: MERGE, after: [] };

async function readLine(line: MainLine) {
  const fake = fakeGitHub();
  mainLine(fake, MERGE, line);
  return readMainCi(githubPort(fake.wire), input, clockedTiming(), new AbortController().signal);
}

describe("readMainCi on a red that main has moved past while its tip still runs", () => {
  it("reads the red as stale when a commit between it and the tip is green on every required context", async () => {
    const result = await readLine({ mergeRuns: [red("validate", 1), successRun("dag-check", 2)], greenRuns: requiredGreen(3) });

    expect(result).toMatchObject({ verdict: "green", mergeSha: MERGE, readSha: GREEN, acknowledgedSha: GREEN, detail: expect.stringContaining("stale") });
  });

  it("keeps the red when the green commit does not contain the red sha", async () => {
    const result = await readLine({ mergeRuns: [red("validate", 1), successRun("dag-check", 2)], greenRuns: requiredGreen(3), greenBase: fakeSha("elsewhere") });

    expect(result).toMatchObject({ verdict: "red", detail: "failed: validate" });
  });

  it("keeps the red when the green commit is not on the base branch's line to its tip", async () => {
    const result = await readLine({ mergeRuns: [red("validate", 1), successRun("dag-check", 2)], greenRuns: requiredGreen(3), tipBase: fakeSha("elsewhere") });

    expect(result).toMatchObject({ verdict: "red", detail: "failed: validate" });
  });
});

const hosts: FactoryHost[] = [];
afterEach(() => hosts.splice(0).forEach((host) => host.close()));

/** A Shepherd run with active-work and agent-chat wired; `onMerge` lays out main the first time the merge sha is read. */
function redWorld(onMerge: (fake: FakeGitHub, merge: string) => void) {
  const fake = fakeGitHub();
  fake.addPr({ headSha: H1 });
  fake.onGetPr = (pr) => fake.setRuns(pr.headSha, requiredGreen(1));
  const base = githubPort(fake.wire);
  let laid = false;
  const layOut = (sha: string) => {
    if (laid || sha !== fake.pr(1).mergeSha) return;
    laid = true;
    onMerge(fake, sha);
  };
  const port = { ...base, checkRuns: async (repo: string, sha: string) => (layOut(sha), base.checkRuns(repo, sha)) };
  const added: string[] = [];
  const mainRed: Omit<MainRedWiring, "freezes"> = {
    tasks: { findByTag: async () => undefined, add: async (_initiative, fields) => `FX-${added.push(fields.title)}` },
    fixers: { roster: async () => [], spawn: async () => undefined },
    checkoutFor: () => tmpdir(),
  };
  let clock = 0;
  const freeze = freezeStoreRef(() => clock);
  const routes = factoryRoutesFor({ port, store: shepherdStoreRef(), freeze, now: () => clock, sleep: async (ms, signal) => (signal.throwIfAborted(), void (clock += ms)), mainRed });
  const host = openFactoryHost({ dbPath: ":memory:", workflows: [shepherdPrWorkflow()], routes, gatePollMs: 5 });
  hosts.push(host);
  return { host, fake, added, freezes: () => freeze.get() };
}

async function merged(w: ReturnType<typeof redWorld>): Promise<string> {
  const runId = w.host.runtime.start("shepherd-pr", { repo: REPO, pr: "1", policy: JSON.stringify(OWNER_GATE_POLICY) });
  await gateOpened(w.host, gateId(runId, "approve-merge"));
  w.host.runtime.signal(runId, "approve-merge", { decision: "merge", headSha: H1 }, OWNER);
  return runId;
}

const stepIds = (w: ReturnType<typeof redWorld>, runId: string) => Object.values(w.host.runtime.status(runId)!.stepResults).map((result) => result.stepId);

describe("shepherd-pr on a main red that is stale or only cancelled", () => {
  it("freezes nothing and files no task for a red at the merge once a descendant went green", async () => {
    const w = redWorld((fake, merge) => mainLine(fake, merge, { mergeRuns: [red("validate", 5), successRun("dag-check", 6)], greenRuns: requiredGreen(7) }));
    const runId = await merged(w);

    await w.host.runtime.wait(runId);

    expect(stepIds(w, runId)).not.toContain("sh-freeze");
    expect(w.freezes().isFrozen(REPO)).toBe(false);
    expect(w.added).toEqual([]);
  });

  it("freezes nothing when the merge's run was cancelled and a required job skipped behind the cancel", async () => {
    const w = redWorld((fake, merge) => {
      fake.setRuns(merge, [successRun("validate", 5, undefined, "cancelled"), successRun("dag-check", 6, undefined, "skipped")]);
      fake.refs.set("main", merge);
    });
    const runId = await merged(w);

    await gateOpened(w.host, gateId(runId, "main-ci-timeout"));

    expect(stepIds(w, runId)).not.toContain("sh-freeze");
    expect(w.freezes().isFrozen(REPO)).toBe(false);
    expect(w.added).toEqual([]);
  });

  it("still freezes and files a task for a red with no green descendant", async () => {
    const w = redWorld((fake, merge) => mainLine(fake, merge, { mergeRuns: [red("validate", 5), successRun("dag-check", 6)], greenRuns: [red("validate", 7), successRun("dag-check", 8)] }));
    const runId = await merged(w);

    await gateOpened(w.host, gateId(runId, "main-frozen"));

    expect(w.freezes().get(REPO)?.redSha).toBe(w.fake.pr(1).mergeSha);
    expect(w.added).toHaveLength(1);
  });

  it("freezes the newer push the red was read at, not the merge sha whose run concurrency cancelled", async () => {
    const NEWER = fakeSha("red-newer-push");
    const w = redWorld((fake, merge) => {
      fake.refs.set("main", NEWER);
      fake.compares.set(`${merge}...${NEWER}`, { mergeBaseSha: merge, files: [] });
      fake.setRuns(NEWER, [red("validate", 7), successRun("dag-check", 8)]);
    });
    const runId = await merged(w);

    await gateOpened(w.host, gateId(runId, "main-frozen"));

    expect(w.freezes().get(REPO)?.redSha).toBe(NEWER);
    expect(w.added).toEqual([expect.stringContaining(NEWER.slice(0, 7))]);
  });
});
