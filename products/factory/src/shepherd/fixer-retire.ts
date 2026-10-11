import type { Freeze } from "./freeze.js";
import { redactForEvidence } from "../redact.js";
import type { Presence } from "./presence.js";

/** How often serve looks for fixers whose red main is over, besides each thaw. */
export const FIXER_RETIRE_MS = 10 * 60_000;

/** Shepherd's fixer names: `fixerName` gives `fix-<repo slug>-<first 7 of the red merge sha>`. */
const FIXER_NAME = /^fix-([a-z0-9-]+)-[0-9a-f]{7}$/;

export interface FixerRetirePorts {
  roster(): Promise<readonly { name: string; presence: Presence }[]>;
  /** Removes the agent's clean pushed worktree and keeps its branch; throws when the tree is dirty, unpushed or in use. */
  park(name: string): void;
  /** Never forced. */
  retire(name: string): Promise<void>;
}

interface FixerRetireNote {
  fixer: string;
  outcome: "retired" | "left";
  detail: string;
}

/** The agent's process is gone, so parking its tree takes nothing from a running session. */
const FINISHED: ReadonlySet<Presence> = new Set<Presence>(["exited", "detached"]);

const slugOf = (freeze: Pick<Freeze, "repo">): string => (freeze.repo.split("/")[1] ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32);

/**
 * Retires each fixer whose red main is over, which is every fixer the live freezes do not name: a thaw clears the freeze
 * row's fixer, so the roster is the only record of an ended run's fixer. A repo frozen with no fixer recorded yet may be
 * mid-spawn, so its name is left. The agent goes only after its tree parked, so a dirty or unpushed tree keeps its agent
 * and is logged for the owner; a fixer still running is never touched.
 */
export async function retireEndedFixers(ports: FixerRetirePorts, frozen: readonly Freeze[]): Promise<FixerRetireNote[]> {
  const named = new Set(frozen.flatMap((freeze) => (freeze.fixer === null ? [] : [freeze.fixer])));
  const pending = new Set(frozen.filter((freeze) => freeze.fixer === null).map(slugOf));
  const notes: FixerRetireNote[] = [];
  for (const row of await ports.roster()) {
    const repoSlug = FIXER_NAME.exec(row.name)?.[1];
    if (repoSlug === undefined || named.has(row.name) || pending.has(repoSlug)) continue;
    if (!FINISHED.has(row.presence)) continue;
    notes.push(await retireOne(ports, row.name));
  }
  return notes;
}

const reasonOf = (error: unknown): string => redactForEvidence(error instanceof Error ? error.message : String(error));

async function retireOne(ports: FixerRetirePorts, fixer: string): Promise<FixerRetireNote> {
  try {
    ports.park(fixer);
  } catch (error) {
    return { fixer, outcome: "left", detail: `its worktree was not parked: ${reasonOf(error)}` };
  }
  try {
    await ports.retire(fixer);
    return { fixer, outcome: "retired", detail: "worktree parked, branch kept" };
  } catch (error) {
    return { fixer, outcome: "left", detail: `parked, but the retire failed: ${reasonOf(error)}` };
  }
}
