import { lineSourceFromTexts } from "@titan-design/evidence";
import type { ReviewerAgent, ReviewerMessage } from "@titan-design/review-panel";
import type { HeadSnapshot, ParkedRun, ParkingPort, ReviewBodyPorts } from "@titan-design/review-workflow";
import { partialFake } from "@titan-design/test-kit";
import type { MemberScript, ReplayInput, Reply } from "./scenario.js";
import type { ReplayWorld } from "./replay.js";

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

function snapshotOf(input: ReplayInput): HeadSnapshot {
  const { target, base, changedFiles, authorityTouch } = input;
  const pr: HeadSnapshot["pr"] = {
    number: target.pr, state: "open", merged: false, mergeSha: null, mergedAt: null, headRef: "feat/replay", headSha: target.head,
    headRepo: null, baseRef: "main", draft: false, mergeableState: "clean", behind: false, autoMerge: false,
  };
  return { pr, ci: "green", facts: { ...target, base, changedFiles, authorityTouch } };
}

/** Which reply a member's agent shows: the retry's agent its own, the first agent its first or corrected reply. */
function replyFor(script: MemberScript | undefined, retried: boolean, resumed: boolean): Reply | undefined {
  if (script === undefined) return undefined;
  if (retried) return script.retry;
  return resumed ? script.corrected : script.first;
}

const shapeOf = (agent: string, shapes: readonly string[]): string | undefined => shapes.find((shape) => agent.includes(shape));

/** A message as the reader returns it; a usage-limit notice is the client's own record, so it carries `synthetic`. */
function messageOf(row: ReviewerAgent, reply: Reply, writtenAt: number): ReviewerMessage {
  const base = { agentId: row.agentId, sessionId: row.sessionId, writtenAt, locator: locatorFor(row.sessionId) };
  if ("say" in reply) return { ...base, text: reply.say };
  return { ...base, text: "You've hit your usage limit", synthetic: { apiError: "usage_limit_reached", resetsAt: reply.usageLimit.resetsAt } };
}

type World = { now: number; rows: ReviewerAgent[]; spawns: string[] };
type HeadPorts = Pick<ReviewBodyPorts, "snapshot" | "proofReader" | "carry" | "checkout" | "headroom" | "profiles" | "source">;

/** An open, green, clean PR whose checkout is ready and whose account has headroom. */
function headPorts(input: ReplayInput): HeadPorts {
  return {
    snapshot: { read: async () => snapshotOf(input) },
    proofReader: { read: async () => input.proof },
    carry: { probe: async () => ({ kind: "no-carry" }) },
    checkout: { state: async () => ({ kind: "ready" }), refresh: async () => undefined },
    headroom: { read: async () => ({ opus: true, account: "available" }) },
    profiles: { installed: (profile) => !input.uninstalled.includes(profile) },
    source: lineSourceFromTexts(input.sources),
  };
}

/** One broker: a shape's second spawn is its retry, and a reply is written just after its agent's spawn or resume. */
function brokerPorts(input: ReplayInput, world: World): Pick<ReviewBodyPorts, "reader" | "dispatch"> {
  const sent = new Map<string, { at: number; resumed: boolean; retried: boolean }>();
  const shapes = Object.keys(input.members);
  const read = async (agentId: string): Promise<ReviewerMessage[]> => {
    const row = world.rows.find((agent) => agent.agentId === agentId);
    const last = row && sent.get(row.name);
    const shape = row && shapeOf(row.name, shapes);
    const reply = last && shape !== undefined ? replyFor(input.members[shape], last.retried, last.resumed) : undefined;
    return row && last && reply ? [messageOf(row, reply, last.at)] : [];
  };
  const spawn = async (agent: string): Promise<void> => {
    const shape = shapeOf(agent, shapes) ?? agent;
    const retried = world.spawns.some((spawned) => shapeOf(spawned, shapes) === shape);
    const neverStarts = !retried && input.members[shape]?.neverStarts === true;
    world.spawns.push(agent);
    world.rows.push({ name: agent, agentId: `agent-${agent}`, sessionId: neverStarts ? "" : `session-${agent}`, presence: "live", spawnedBy: null });
    sent.set(agent, { at: world.now + 1, resumed: false, retried });
  };
  const resume = async (agent: string): Promise<void> => {
    world.now += 1;
    sent.set(agent, { at: world.now + 1, resumed: true, retried: sent.get(agent)?.retried ?? false });
  };
  return { reader: { read: (awaiting) => read(awaiting.reviewerAgentId) }, dispatch: { roster: async () => world.rows, spawn, resume } };
}

/** The deterministic ports one case replays over: one broker and one clock, each member's scripted reply, and no model, network or disk. */
export function replayWorld(input: ReplayInput): ReplayWorld {
  const world: World = { now: 1_000_000, rows: [], spawns: [] };
  const ports: ReviewBodyPorts = {
    ...headPorts(input),
    ...brokerPorts(input, world),
    clock: { now: () => world.now, sleep: async (ms) => void (world.now += ms) },
    fixer: { roster: async () => [], spawn: async () => undefined },
    parking: fakeParking(),
  };
  return { ports, sessions: () => world.spawns.length };
}
