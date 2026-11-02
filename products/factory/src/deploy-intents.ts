import { z } from "zod";
import { showAt } from "./deploy-range.js";
import { isFactEntry } from "./registry/entry.js";
import { factoryRegistry } from "./registry/steps/index.js";
import type { CommandResult } from "./run-command.js";

/** Per step, its intents with no terminal result; throws when the factory db cannot be read. */
export type OpenIntents = (steps: readonly string[]) => Readonly<Record<string, number>>;

export interface IntentPorts {
  git: (args: readonly string[]) => Promise<CommandResult>;
  openIntents: OpenIntents;
}

const LOCK_PATH = "products/factory/src/registry/closure.lock.json";
const lockSchema = z.record(z.string(), z.object({ schemaHash: z.string(), bump: z.number() }));
type Lock = z.infer<typeof lockSchema>;
type Row = Lock[string];

const IRREVERSIBLE_FACTS = factoryRegistry.entries.filter((entry) => isFactEntry(entry) && entry.effect.class === "irreversible").map((entry) => entry.name);

async function lockAt(git: IntentPorts["git"], sha: string): Promise<Lock | undefined> {
  const text = await showAt(git, sha, LOCK_PATH);
  if (text === undefined) return undefined;
  try {
    const parsed = lockSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

const label = (row: Row): string => `${row.schemaHash.slice(0, 12)}+b${row.bump}`;

/** A step with no row at either sha has no earlier version to change from. */
function movedSteps(before: Lock, after: Lock): { step: string; change: string }[] {
  return IRREVERSIBLE_FACTS.flatMap((step) => {
    const [old, next] = [before[step], after[step]];
    if (old === undefined || next === undefined || (old.schemaHash === next.schemaHash && old.bump === next.bump)) return [];
    return [{ step, change: `${step} changes version (${label(old)} -> ${label(next)})` }];
  });
}

/**
 * An irreversible step's in-flight intent was made under its old version, so a new version must not land under it.
 * An unknown `from` (a dirty build) has no lock to compare, as with cleanSha; an unreadable db refuses only when a version moved.
 */
export async function versionRefusal(ports: IntentPorts, from: string | undefined, target: string): Promise<string | undefined> {
  if (from === undefined) return undefined;
  const [before, after] = await Promise.all([lockAt(ports.git, from), lockAt(ports.git, target)]);
  const moved = before === undefined || after === undefined ? [] : movedSteps(before, after);
  if (moved.length === 0) return undefined;
  let open: Readonly<Record<string, number>>;
  try {
    open = ports.openIntents(moved.map(({ step }) => step));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return `${moved.map(({ change }) => change).join("; ")} and its open intents cannot be read (${why}); fix the factory db and redeploy`;
  }
  const blocked = moved.filter(({ step }) => (open[step] ?? 0) > 0);
  if (blocked.length === 0) return undefined;
  const lines = blocked.map(({ step, change }) => `${change} while ${open[step]} intent(s) for it have no result`);
  return `${lines.join("; ")}; wait for them to settle (titan-factory shepherd status) and redeploy`;
}
