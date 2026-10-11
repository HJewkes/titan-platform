import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StepResult, WorkflowRun } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches } from "../definition.js";
import { resolveCommand } from "../registry.js";
import type { WatchRow } from "./view.js";

/** Often enough that a gate reaches its seat within a minute; the sweep reads only the local store, never GitHub. */
export const SEAT_DIGEST_MS = 60_000;
const SEAT_DIGEST_FILE = "seat-digest.json";

/** Where a digest goes: the seat book read once per sweep, naming the one seat that owns a repo, and the send. A repo no single seat owns gets no digest. */
export interface SeatDigestPorts {
  seatLookup(): (repo: string) => string | undefined;
  send(seat: string, text: string): Promise<void>;
}

/** What a seat was last told: the open items by key, and every finished run it has heard of. */
const SeatStateSchema = z.object({ open: z.array(z.string()), finished: z.array(z.string()) });
export type SeatState = z.infer<typeof SeatStateSchema>;

export interface SeatDigestMemory {
  get(seat: string): SeatState | undefined;
  set(seat: string, state: SeatState): void;
}

export interface DigestInput {
  row: WatchRow;
  run: WorkflowRun;
}

interface Item {
  key: string;
  line: string;
}

interface SeatView {
  open: Item[];
  finished: Item[];
}

const SEAT_FIX_GATES: ReadonlySet<string> = new Set(["ci-failed", "sh-sent-back"]);
const SeatNoticeRecord = z.looseObject({ result: z.looseObject({ sent: z.literal(true), gate: z.string(), headSha: z.string() }) });

const pr = (row: WatchRow): string => `${row.repo}#${row.pr ?? row.branch}`;

function gateItem(row: WatchRow): Item | undefined {
  const gate = row.pendingGate;
  if (gate === null) return undefined;
  return { key: `gate:${gate.gateId}`, line: `- ${pr(row)} waits on ${gate.stepId}: \`${resolveCommand(row.runId, gate.stepId)}\`` };
}

function latestSeatNotice(run: WorkflowRun): StepResult | undefined {
  const notices = Object.values(run.stepResults).filter((result) => stepIdMatches("sh-seat-notice", result.stepId));
  return notices.sort((a, b) => a.completedAt.localeCompare(b.completedAt)).at(-1);
}

/** A run the seat was told to fix waits for a new head with no gate and no fixer; only its record shows the seat owns it. */
function seatFixItem({ row, run }: DigestInput): Item | undefined {
  if (row.pendingGate !== null || row.outcome !== null || run.currentStep === null || !stepIdMatches("await-new-head", run.currentStep)) return undefined;
  const notice = SeatNoticeRecord.safeParse(latestSeatNotice(run)?.data);
  if (!notice.success || !SEAT_FIX_GATES.has(notice.data.result.gate) || notice.data.result.headSha !== row.headSha) return undefined;
  const { gate, headSha } = notice.data.result;
  return { key: `seat:${row.runId}:${gate}:${headSha}`, line: `- ${pr(row)} ${gate} at ${headSha.slice(0, 7)}, no fixer woken: start a fix round, push a fix, or close the PR` };
}

function finishedItem(row: WatchRow): Item | undefined {
  if (row.outcome === null) return undefined;
  const how = row.outcome.kind === "merged" ? "merged" : `stopped${row.outcome.reason === null ? "" : ` (${row.outcome.reason})`}`;
  return { key: row.runId, line: `- ${pr(row)} ${how}` };
}

/** Each seat's open items and finished runs, from the watch rows; a repo no single seat owns is left out. */
function seatViews(inputs: readonly DigestInput[], seatFor: (repo: string) => string | undefined): Map<string, SeatView> {
  const views = new Map<string, SeatView>();
  for (const input of inputs) {
    const seat = seatFor(input.row.repo);
    if (seat === undefined) continue;
    const view = views.get(seat) ?? views.set(seat, { open: [], finished: [] }).get(seat)!;
    const open = gateItem(input.row) ?? seatFixItem(input);
    if (open) view.open.push(open);
    const finished = finishedItem(input.row);
    if (finished) view.finished.push(finished);
  }
  return views;
}

/**
 * The message for a change, or undefined when nothing changed. A seat seen for the first time has its finished runs
 * taken as already known, so a first sweep does not replay history; it hears only of open items.
 */
function digestText(seat: string, view: SeatView, last: SeatState | undefined): string | undefined {
  const known = new Set(last?.finished ?? view.finished.map((item) => item.key));
  const fresh = view.finished.filter((item) => !known.has(item.key));
  const open = [...view.open].sort((a, b) => a.key.localeCompare(b.key));
  const sameOpen = open.map((item) => item.key).join("\n") === [...(last?.open ?? [])].sort().join("\n");
  if (sameOpen && fresh.length === 0) return undefined;
  const lines = [`Shepherd digest for ${seat}: ${open.length} open, ${fresh.length} newly finished.`];
  lines.push(open.length > 0 ? "Open:" : "Open: none.", ...open.map((item) => item.line));
  if (fresh.length > 0) lines.push("Finished:", ...fresh.map((item) => item.line));
  return lines.join("\n");
}

const stateOf = (view: SeatView): SeatState => ({ open: view.open.map((item) => item.key).sort(), finished: view.finished.map((item) => item.key).sort() });

/** One message per seat whose state changed. A failed send leaves its memory alone, so the next sweep tries again. */
export async function sendSeatDigests(inputs: readonly DigestInput[], ports: SeatDigestPorts, memory: SeatDigestMemory): Promise<{ sent: string[]; failed: { seat: string; cause: string }[] }> {
  const sent: string[] = [];
  const failed: { seat: string; cause: string }[] = [];
  for (const [seat, view] of seatViews(inputs, ports.seatLookup())) {
    const last = memory.get(seat);
    const text = digestText(seat, view, last);
    const state = stateOf(view);
    try {
      if (text !== undefined) await ports.send(seat, text);
      if (JSON.stringify(state) !== JSON.stringify(last)) memory.set(seat, state);
      if (text !== undefined) sent.push(seat);
    } catch (error) {
      failed.push({ seat, cause: error instanceof Error ? error.message : String(error) });
    }
  }
  return { sent, failed };
}

const MemoryFile = z.record(z.string(), SeatStateSchema);

function readMemory(path: string): Record<string, SeatState> {
  if (!existsSync(path)) return {};
  try {
    const parsed = MemoryFile.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

/** The memory as one JSON file beside the factory database, so a restart does not resend; an unreadable file starts empty. */
export function fileSeatDigestMemory(stateDir: string): SeatDigestMemory {
  const path = join(stateDir, SEAT_DIGEST_FILE);
  const states = readMemory(path);
  return {
    get: (seat) => states[seat],
    set: (seat, state) => {
      states[seat] = state;
      writeFileSync(`${path}.tmp`, JSON.stringify(states));
      renameSync(`${path}.tmp`, path);
    },
  };
}
