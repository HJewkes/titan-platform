import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { clearManualHold, readManualHold, writeManualHold, type ManualHold, type ManualState } from "./deploy-pause.js";
import type { LockPorts } from "./deploy-lock.js";
import { morningDeployHolds, type MorningDeployHold } from "./needs/morning-items.js";

/** A seat rewrites its whole queue file in place, so one read can miss an item that still stands. */
const EMPTY_READS_TO_CLEAR = 2;

type MorningHoldAction =
  | { kind: "set"; hold: ManualHold }
  | { kind: "replace"; from: string; hold: ManualHold }
  | { kind: "clear"; source: string }
  | { kind: "keep"; why: string };

interface MorningHoldInput {
  manual: ManualState;
  /** Undefined when the queue dir or any seat file could not be read. */
  items: readonly MorningDeployHold[] | undefined;
  /** Consecutive earlier reads that found no deploy-hold item. */
  emptyBefore: number;
  now: string;
}

const holdFor = (item: MorningDeployHold, now: string): ManualHold => ({ heldAt: now, reason: `Morning ${item.id}: ${item.reason}`, source: item.id });

/** A hold with no `source`, or one that does not parse, is the owner's own and is never written over or cleared. */
export function reconcileMorningHold({ manual, items, emptyBefore, now }: MorningHoldInput): MorningHoldAction {
  if (items === undefined) return { kind: "keep", why: "the Morning queue could not be read" };
  const source = manual.set ? manual.hold?.source : undefined;
  if (manual.set && source === undefined) return { kind: "keep", why: "a hold set by hand stands" };
  const first = items[0];
  if (first === undefined) {
    if (source === undefined) return { kind: "keep", why: "no Morning deploy hold" };
    return emptyBefore + 1 >= EMPTY_READS_TO_CLEAR ? { kind: "clear", source } : { kind: "keep", why: `${source} is missing from one read` };
  }
  if (source === undefined) return { kind: "set", hold: holdFor(first, now) };
  if (items.some((item) => item.id === source)) return { kind: "keep", why: `${source} still stands` };
  return { kind: "replace", from: source, hold: holdFor(first, now) };
}

interface MorningHoldPorts extends Pick<LockPorts, "createExclusive" | "remove"> {
  exists: (path: string) => boolean;
  /** Undefined when the file cannot be read. */
  readFile: (path: string) => string | undefined;
  writeFile: (path: string, text: string) => void;
  /** Undefined when the dir is missing or cannot be read. */
  listFiles: (dir: string) => string[] | undefined;
}

/** Undefined on any read failure, and a missing dir is one, so a moved queue dir never reads as "no items". */
function readMorningDeployHolds(ports: Pick<MorningHoldPorts, "readFile" | "listFiles">, queuesDir: string): MorningDeployHold[] | undefined {
  const files = ports.listFiles(queuesDir);
  if (files === undefined) return undefined;
  const items: MorningDeployHold[] = [];
  for (const file of files.filter((name) => name.endsWith(".md")).sort()) {
    const text = ports.readFile(join(queuesDir, file));
    if (text === undefined) return undefined;
    items.push(...morningDeployHolds(basename(file, ".md"), text));
  }
  return items;
}

function apply(ports: MorningHoldPorts, stateDir: string, action: MorningHoldAction): string | undefined {
  switch (action.kind) {
    case "set":
      return writeManualHold(ports, stateDir, action.hold, { exclusive: true });
    case "replace": {
      const now = readManualHold(ports, stateDir);
      if (!now.set || now.hold?.source !== action.from) return "the hold changed before it could be replaced";
      return writeManualHold(ports, stateDir, action.hold);
    }
    case "clear":
      return clearManualHold(ports, stateDir, action.source) ? undefined : "the hold changed before it could be cleared";
    case "keep":
      return undefined;
  }
}

interface MorningHoldSyncOptions {
  stateDir: string;
  queuesDir: string;
  now: string;
  emptyBefore: number;
}

interface MorningHoldSync {
  action: MorningHoldAction;
  /** Pass back as `emptyBefore` on the next sync; a failed read resets it, so it never counts toward a clear. */
  emptyReads: number;
  failed?: string;
}

/** Touches only `deploy-hold.json`; the failure pause is lifted by `service pause --clear` alone. */
export function syncMorningHold(ports: MorningHoldPorts, { stateDir, queuesDir, now, emptyBefore }: MorningHoldSyncOptions): MorningHoldSync {
  const items = readMorningDeployHolds(ports, queuesDir);
  const action = reconcileMorningHold({ manual: readManualHold(ports, stateDir), items, emptyBefore, now });
  const failed = apply(ports, stateDir, action);
  return { action, emptyReads: items?.length === 0 ? emptyBefore + 1 : 0, ...(failed !== undefined && { failed }) };
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function createExclusive(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, { flag: "wx" });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return false;
    throw error;
  }
}

export const nodeMorningHoldPorts: MorningHoldPorts = {
  exists: existsSync,
  readFile: readIfPresent,
  writeFile: (path, text) => writeFileSync(path, text),
  createExclusive,
  remove: (path) => rmSync(path, { force: true }),
  listFiles: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return undefined;
    }
  },
};
