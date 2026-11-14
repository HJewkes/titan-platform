import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { errorMessage } from "../../narrow.js";
import { compareSettings, type RuleFile, type ShadowLane } from "./rule-file.js";

/*
 * The ready-stock trigger (TP-5964): a lane whose dispatchable count is under its rule-file floor asks its coordinator
 * for a refill, at most once per lane per UTC day. A lane with no floor is never counted, so floors absent means inert.
 */

export interface RefillPorts {
  /** The lane's open tasks that pass the census's dispatchable rule. */
  dispatchable: (lane: ShadowLane) => Promise<number>;
  send: (to: string, text: string) => Promise<void>;
}

export interface RefillOutcome {
  lane: string;
  to: string;
  floor: number;
  /** Absent when the lane's tasks could not be read. */
  count?: number;
  result: "sent" | "already-sent" | "failed";
  detail?: string;
}

interface RefillInput {
  rules: RuleFile;
  /** The shadow dir; the day's sent requests are kept under `refill/`. */
  dir: string;
  now: Date;
  ports: RefillPorts;
}

const SentRow = z.object({ lane: z.string() });

const laneLabel = (lane: ShadowLane): string => (lane.tag === null ? lane.initiative : `${lane.initiative}[${lane.tag}]`);

const ledgerFile = (dir: string, now: Date): string => join(dir, "refill", `${now.toISOString().slice(0, 10)}.jsonl`);

function sentToday(file: string): Set<string> {
  if (!existsSync(file)) return new Set();
  const lanes = readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        return [SentRow.parse(JSON.parse(line)).lane];
      } catch {
        return [];
      }
    });
  return new Set(lanes);
}

function recordSent(file: string, row: { lane: string; to: string; count: number; floor: number; at: string }): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

const refillText = (lane: string, count: number, floor: number): string =>
  `Ready-stock refill: lane ${lane} has ${count} dispatchable task(s), under its floor of ${floor}. Please slice and tag ready work for it; this request is sent at most once a day.`;

async function refillLane(lane: ShadowLane & { floor: number }, input: RefillInput, sent: Set<string>): Promise<RefillOutcome | undefined> {
  const label = laneLabel(lane);
  const to = lane.coordinator ?? compareSettings(input.rules).operator;
  const base = { lane: label, to, floor: lane.floor };
  let count: number;
  try {
    count = await input.ports.dispatchable(lane);
  } catch (error) {
    return { ...base, result: "failed", detail: `count: ${errorMessage(error)}` };
  }
  if (count >= lane.floor) return undefined;
  if (sent.has(label)) return { ...base, count, result: "already-sent" };
  try {
    await input.ports.send(to, refillText(label, count, lane.floor));
  } catch (error) {
    return { ...base, count, result: "failed", detail: `send: ${errorMessage(error)}` };
  }
  recordSent(ledgerFile(input.dir, input.now), { lane: label, to, count, floor: lane.floor, at: input.now.toISOString() });
  sent.add(label);
  return { ...base, count, result: "sent" };
}

const hasFloor = (lane: ShadowLane): lane is ShadowLane & { floor: number } => lane.floor !== undefined;

/** One outcome per lane under its floor; a lane at or above its floor, or with none, yields nothing. */
export async function refillLanes(input: RefillInput): Promise<RefillOutcome[]> {
  const floored = input.rules.lanes.filter(hasFloor);
  if (floored.length === 0) return [];
  const sent = sentToday(ledgerFile(input.dir, input.now));
  const outcomes: RefillOutcome[] = [];
  for (const lane of floored) {
    const outcome = await refillLane(lane, input, sent);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}
