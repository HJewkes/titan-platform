import { lineSourceFromTexts } from "@titan-design/evidence";
import { formatResultLine } from "@titan-design/fix-proof";
import type { PullRequest } from "@titan-design/github";
import { DEFAULT_PANEL_TABLE, memberName, type ReviewerAgent, type ReviewerMessage, type ReviewTarget } from "@titan-design/review-panel";
import { partialFake } from "@titan-design/test-kit";
import type { ReviewBodyPorts } from "./bodies.js";
import type { ReviewRequestInput } from "./definition.js";
import type { ParkedRun, ParkingPort } from "./fixer.js";
import type { ReviewPlanPolicy } from "./plan-for-head.js";
import type { ReviewHeadInput } from "./types.js";

export const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const target: ReviewTarget = { repo: "acme/widgets", pr: 7, head: HEAD };
export const name = (shape: "correctness" | "adversary", attempt: 1 | 2 = 1): string => memberName(target, shape, attempt);

export const POLICY: ReviewPlanPolicy = {
  panel: {
    roles: { g10: "bd-reviewer", standard: "reviewer" },
    shapeRoles: { adversary: { g10: "fable-reviewer", standard: "fable-reviewer" } },
    panel: DEFAULT_PANEL_TABLE,
  },
};
export const TIMING = { pollMs: 1_000, startDeadlineMs: 5_000, verdictDeadlineMs: 10_000 };

/** A vacuous line its mutants prove: tp#2145's proof, which spent 8 reviewer sessions on 2 verdicts. */
const provedByMutants = formatResultLine({
  head: HEAD,
  mergeBase: BASE,
  verdict: "vacuous",
  counts: { reproduces: 0, "passes-on-base": 1, "new-api": 0, "fails-on-head": 0, "not-run": 0 },
  notCollected: [],
  deletedTests: [],
  configEdited: false,
  tests: [{ file: "src/widget.test.ts", name: "holds", class: "passes-on-base" }],
  truncated: false,
  mutants: { verdict: "killed", results: [{ spec: "src/widget.test.mutations.json", name: "drop the bound", outcome: "killed" }], uncovered: [] },
});

export const request: ReviewRequestInput = { target, kind: "feature", brief: { checkoutRoot: "/tmp/reviews", fixProof: provedByMutants } };
export const input: ReviewHeadInput = { runId: "run-1", ...request };

type Reply = string | undefined;
/** What the member under `agent` has written last, before or after its correction. */
type Script = (agent: string, resumed: boolean) => Reply;

export const MERGE = `Probes: drove the bound past its edge.\n\nVerdict: MERGE\nPR: ${target.repo}#${target.pr}\nHead: ${HEAD}\n`;
export const merges: Script = () => MERGE;
type Locator = ReviewerMessage["locator"];
const locatorFor = (sessionId: string): Locator =>
  partialFake<Locator>({ source: partialFake<Locator["source"]>({ conversation: partialFake<Locator["source"]["conversation"]>({ nativeId: sessionId }) }) });

function fakeParking(): ParkingPort {
  let runs: ParkedRun[] = [];
  const rounds = new Map<string, number>();
  return {
    park: async (run) => void (runs.some((parked) => parked.runId === run.runId) || runs.push(run)),
    parked: async (fingerprint) => runs.filter((run) => run.fingerprint === fingerprint),
    release: async (fingerprint) => {
      const released = runs.filter((run) => run.fingerprint === fingerprint);
      runs = runs.filter((run) => run.fingerprint !== fingerprint);
      rounds.set(fingerprint, (rounds.get(fingerprint) ?? 0) + 1);
      return released;
    },
    round: async (fingerprint) => rounds.get(fingerprint) ?? 0,
  };
}

const newWorld = () => ({ now: 1_000_000, rows: [] as ReviewerAgent[], spawns: [] as string[], resumes: [] as string[], fixers: [] as string[], snapshotReads: 0, installed: true, readsHang: false });
type World = ReturnType<typeof newWorld>;
type HeadPorts = Pick<ReviewBodyPorts, "snapshot" | "proofReader" | "carry" | "checkout" | "headroom" | "profiles" | "source">;

/** An open, green, clean PR whose fix-proof its mutants prove. */
function headPorts(world: World): HeadPorts {
  const pr: PullRequest = {
    number: target.pr, state: "open", merged: false, mergeSha: null, mergedAt: null, headRef: "feat/widgets", headSha: HEAD,
    headRepo: null, baseRef: "main", draft: false, mergeableState: "clean", behind: false, autoMerge: false,
  };
  const changedFiles = [{ path: "src/widget.ts", additions: 6, deletions: 2 }, { path: "src/widget.test.ts", additions: 12, deletions: 0 }];
  return {
    snapshot: { read: async () => ((world.snapshotReads += 1), { pr, ci: "green", facts: { ...target, base: BASE, changedFiles, authorityTouch: true } }) },
    proofReader: { read: async () => ({ kind: "result", line: provedByMutants }) },
    carry: { probe: async () => ({ kind: "no-carry" }) },
    checkout: { state: async () => ({ kind: "ready" }), refresh: async () => undefined },
    headroom: { read: async () => ({ opus: true, account: "available" }) },
    profiles: { installed: () => world.installed },
    source: lineSourceFromTexts({}),
  };
}

/**
 * One broker: a spawn adds a row, started unless named in `neverStarts`; a reply is written just after its spawn or
 * resume. `readsHang` stands for a process that died mid-await.
 */
function brokerPorts(world: World, script: Script, neverStarts: readonly string[]): Pick<ReviewBodyPorts, "reader" | "dispatch"> {
  const sent = new Map<string, { at: number; resumed: boolean }>();
  const read = async (agentId: string): Promise<ReviewerMessage[]> => {
    const row = world.rows.find((agent) => agent.agentId === agentId);
    const last = row && sent.get(row.name);
    const text = row && last && script(row.name, last.resumed);
    return row && last && text !== undefined ? [{ agentId, sessionId: row.sessionId, writtenAt: last.at, locator: locatorFor(row.sessionId), text }] : [];
  };
  return {
    reader: { read: (awaiting) => (world.readsHang ? new Promise<never>(() => undefined) : read(awaiting.reviewerAgentId)) },
    dispatch: {
      roster: async () => world.rows,
      spawn: async (agent) => {
        world.spawns.push(agent);
        world.rows.push({ name: agent, agentId: `agent-${agent}`, sessionId: neverStarts.includes(agent) ? "" : `session-${agent}`, presence: "live", spawnedBy: null });
        sent.set(agent, { at: world.now + 1, resumed: false });
      },
      resume: async (agent) => {
        world.resumes.push(agent);
        world.now += 1;
        sent.set(agent, { at: world.now + 1, resumed: true });
      },
    },
  };
}

/** One broker and one clock over one head. */
export function fakeWorld(script: Script, neverStarts: readonly string[] = []) {
  const world = newWorld();
  const ports: ReviewBodyPorts = {
    ...headPorts(world),
    ...brokerPorts(world, script, neverStarts),
    clock: { now: () => world.now, sleep: async (ms) => void (world.now += ms) },
    fixer: { roster: async () => [], spawn: async (agent) => void world.fixers.push(agent) },
    parking: fakeParking(),
  };
  return { world, ports };
}
