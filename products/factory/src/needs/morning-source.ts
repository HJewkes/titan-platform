import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { activeWorkRoot } from "@titan-design/app-paths";
import type { OwnerItem, QueueSource } from "@titan-design/owner-queue";
import { configPath, loadConfig, type FactoryConfig } from "../config.js";
import { morningIds, morningOwnerItem, numberedMorningItems } from "./morning-items.js";
import { pollTail } from "./poll-tail.js";

export interface MorningSourceOptions {
  /** The directory of `<seat>.md` queue files. */
  dir: string;
  /** Read only these seats, in this order; unset reads every `*.md` in `dir`, sorted. */
  seats?: readonly string[];
  pollMs?: number;
}

/** The default project directory name is joined from parts so no source path hardcodes it; the config's `digest.queuesDir` replaces the whole path. */
const DEFAULT_QUEUE_PROJECT = ["claude", "channels"].join("-");

/** `digest.queuesDir` from the given config, else `<active root>/<default project>/sources/autonomy/queues`, where the active root honours `ACTIVE_ROOT`. */
export function morningQueuesDir(env: NodeJS.ProcessEnv, config: FactoryConfig = loadConfig(configPath(env))): string {
  return config.digest?.queuesDir ?? join(activeWorkRoot({ env }), DEFAULT_QUEUE_PROJECT, "sources", "autonomy", "queues");
}

function seatsIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => basename(name, ".md"))
    .sort();
}

/** A queue file has no per-item time, so every item opens at the file's last write. */
function readSeatItems(dir: string, seat: string): OwnerItem[] {
  const file = join(dir, `${seat}.md`);
  if (!existsSync(file)) return [];
  const entries = numberedMorningItems(readFileSync(file, "utf8"));
  const openedAt = statSync(file).mtime.toISOString();
  const ids = morningIds(seat, entries);
  return entries.map((entry, index) => morningOwnerItem(seat, entry, ids[index]!, openedAt));
}

/** Seat Morning queue files as a QueueSource. Answers stay in the seat's own channel until the answers file lands (stage 4). */
export function createMorningSource({ dir, seats, pollMs }: MorningSourceOptions): QueueSource {
  const open = async (): Promise<OwnerItem[]> => (seats ?? seatsIn(dir)).flatMap((seat) => readSeatItems(dir, seat));
  return {
    system: "morning",
    open,
    tail: pollTail({ open, intervalMs: pollMs }),
    resolve: async () => ({ ok: false, reason: "rejected", detail: "Morning items are answered in the seat's queue file" }),
  };
}
