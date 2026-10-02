import type { JsonEnvelope } from "@titan-design/registry";
import { configPath, loadConfig } from "../config.js";
import type { WatchRow } from "../shepherd/view.js";
import type { DigestSources, GateFact } from "./collect.js";
import { buildDigest, deliverDigest } from "./run.js";
import { currentSlot, DEFAULT_SLOTS, DEFAULT_TIMEZONE } from "./slots.js";
import { digestDirectories, execProcess, fileSources, readAgentChat, type Exec } from "./sources.js";

/** Runs one factory registry command, on titan-factory serve or in process. */
export type FactoryCall = (name: string, args: object) => Promise<JsonEnvelope<unknown>>;

export interface DigestIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env: NodeJS.ProcessEnv;
}

export interface DigestFlags {
  sinceMinutes?: number;
  dryRun?: boolean;
  full?: boolean;
}

export interface DigestDeps {
  exec?: Exec;
  now?: Date;
}

const UNIT_MINUTES: Readonly<Record<string, number>> = { m: 1, h: 60, d: 1440 };

/** `90m`, `6h` or `2d` as minutes. */
export function parseSince(value: string): number {
  const match = /^([1-9][0-9]*)([mhd])$/.exec(value);
  if (!match) throw new Error(`--since expects a window like 90m, 6h or 2d, got ${JSON.stringify(value)}`);
  return Number(match[1]) * UNIT_MINUTES[match[2]!]!;
}

function factorySources(call: FactoryCall): Pick<DigestSources, "rows" | "gates"> {
  const data = async <T>(name: string, args: object): Promise<T> => {
    const envelope = await call(name, args);
    if (!envelope.ok) throw new Error(envelope.error);
    return envelope.data as T;
  };
  return {
    rows: () => data<WatchRow[]>("shepherd.list", { state: "all" }),
    gates: async () => (await data<{ gates: GateFact[] }>("factory.gates", {})).gates,
  };
}

/** Collect, render and, unless `--dry-run`, write `<date>-<HH>.md` to the out dir and the iCloud dir. */
export async function runDigestVerb(io: DigestIo, call: FactoryCall, flags: DigestFlags, deps: DigestDeps = {}): Promise<number> {
  const config = loadConfig(configPath(io.env));
  const now = deps.now ?? new Date();
  const { slot, windowMinutes } = currentSlot(now, config.digest?.timezone ?? DEFAULT_TIMEZONE, config.digest?.slots ?? DEFAULT_SLOTS);
  const agentChatBin = config.shepherd?.agentChatBin ?? "agent-chat";
  const sources: DigestSources = {
    ...factorySources(call),
    ...fileSources(config),
    agentChat: (minutes) => readAgentChat(deps.exec ?? execProcess, agentChatBin, minutes),
  };
  const markdown = await buildDigest({ sources, now, slot, windowMinutes: flags.sinceMinutes ?? windowMinutes, full: flags.full === true });
  if (flags.dryRun) return (io.stdout(markdown), 0);
  const { written, warnings } = deliverDigest(markdown, slot, digestDirectories(config, io.env));
  for (const warning of warnings) io.stderr(`warning: ${warning}\n`);
  io.stdout(written.map((path) => `wrote ${path}\n`).join(""));
  return 0;
}
