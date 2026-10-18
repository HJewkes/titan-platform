// The twin's whole snapshot: the hand-written answers, plus what the real console commands answer over the
// synthetic active-work fixture and the synthetic review rounds, recorded in process.
import { inProcessCaller, successEnvelope, type InProcessCall } from "@titan-design/registry";
import { SNAPSHOT_FORMAT, snapshotKey, type Snapshot } from "@titan-design/rpc-client";
import type { ConsoleSources } from "../commands.js";
import { fixtureActiveWork } from "../fixtures.js";
import type { ConsoleContext } from "../owner-guard.js";
import { createConsoleRegistry } from "../registry.js";
import { FIXTURE_ROUNDS } from "../round-fixtures.js";
import { HAND_ANSWERS, recorded, type TwinCall, type TwinCommand } from "./answers.js";
import { TWIN_NOW } from "./clock.js";

const NOWHERE = "/nonexistent/titan-console-twin";

const unreachable = (): Promise<never> => Promise.reject(new Error("the twin reads no live source"));

/** Only `activeWork` and `rounds` answer; every other source is recorded by hand in `answers.ts`, so none is ever read. */
function recordingSources(): ConsoleSources {
  return {
    upstreams: [],
    agents: { broker: { read: unreachable, history: unreachable, queue: unreachable }, eventsDbPath: NOWHERE, seatPrefixes: [] },
    sessions: { graphPath: NOWHERE, roots: () => [], now: () => TWIN_NOW },
    activeWork: fixtureActiveWork(),
    inbox: { dir: NOWHERE },
    rounds: FIXTURE_ROUNDS,
    shepherd: { list: unreachable, timeline: unreachable, waiting: unreachable, release: unreachable },
  };
}

/** Each frame the ship-tile round's Design and Ship sections show, with the views its fixture PNGs hold. */
const SHIP_TILE_FRAMES = [
  ["badge-new", "head"],
  ["panel-wide", "head"],
  ["panel-wide", "base"],
  ["tile-dark", "head"],
  ["tile-dark", "base"],
  ["tile-dark", "diff"],
  ["tile-light", "head"],
  ["tile-light", "base"],
  ["tile-light", "diff"],
] as const;

/** The work and rounds calls the twin routes make, answered by the real commands. */
const RECORDED: readonly Pick<TwinCall, "command" | "args">[] = [
  recorded("work.portfolio", {}),
  recorded("work.initiative", { slug: "orbit-relay" }),
  recorded("work.notes", {}),
  recorded("work.record", { ref: "note:orbit-relay/2031-03-03-backoff-ceiling.md" }),
  recorded("rounds.list", {}),
  recorded("rounds.get", { id: "ship-tile-r1" }),
  recorded("rounds.frames", { id: "ship-tile-r1" }),
  ...SHIP_TILE_FRAMES.map(([key, view]) => recorded("rounds.frame", { id: "ship-tile-r1", key, view })),
];

function inProcessContext(): ConsoleContext {
  return { warnings: [], format: "json", surface: "in-process", auth: null, ownerWrites: false };
}

async function record(call: InProcessCall, command: TwinCommand, args: unknown): Promise<[string, Snapshot["calls"][string]]> {
  const envelope = await call(command, args);
  if (!envelope.ok) throw new Error(`twin fixture ${command} ${JSON.stringify(args)} failed: ${envelope.error}`);
  return [snapshotKey(command, args), envelope];
}

/** Built fresh per capture; a duplicate key would let one fixture silently shadow another, so it throws instead. */
export async function twinSnapshot(): Promise<Snapshot> {
  const call = inProcessCaller(createConsoleRegistry(recordingSources()), inProcessContext);
  const fromCommands = await Promise.all(RECORDED.map(({ command, args }) => record(call, command, args)));
  const hand = HAND_ANSWERS.map(({ command, args, result }) => [snapshotKey(command, args), successEnvelope(result)] as const);
  const calls: Snapshot["calls"] = {};
  for (const [key, envelope] of [...fromCommands, ...hand]) {
    if (key in calls) throw new Error(`twin fixture ${key} is recorded twice`);
    calls[key] = envelope;
  }
  return { format: SNAPSHOT_FORMAT, createdAt: new Date(TWIN_NOW).toISOString(), calls };
}
