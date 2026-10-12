import type { GitHubPort, PrFile, RepoSlug } from "@titan-design/github";
import { classifyPr, DEFAULT_CLASS_RULES, type ClassRules } from "@titan-design/review-panel";
import { SHEPHERD_ACTOR } from "./events.js";
import { prChangedLines } from "./reviewer-roles.js";
import type { ShepherdStore } from "./store.js";

/** Factory's store migrations live in plain source files, which the panel's default migration globs miss. */
export const SHEPHERD_CLASS_RULES: ClassRules = {
  ...DEFAULT_CLASS_RULES,
  migration: [...DEFAULT_CLASS_RULES.migration, "**/store-migrations.ts", "**/*-migration*.ts", "**/*-store.ts"],
};

const ADVERSARY_TOUCHES = ["authority", "policy", "security"] as const;

interface HoldTarget {
  repo: RepoSlug;
  pr: number;
  kind: string;
}

/** The panel's class reads an absent kind as unread; only these touches name a hold, so an unread kind alone holds nothing. */
function classOf(files: readonly PrFile[], kind: string): { touches: readonly string[]; lines: number | undefined } {
  const lines = prChangedLines(files, SHEPHERD_CLASS_RULES.largeLines);
  const changedFiles = files.map(({ path, previousPath, additions, deletions }) => ({ path, ...(previousPath !== undefined && { previousPath }), additions: additions ?? 0, deletions: deletions ?? 0 }));
  const { touches } = classifyPr({ repo: "", pr: 0, head: "", base: "", kind, changedFiles }, SHEPHERD_CLASS_RULES);
  return { touches, lines };
}

function reasonFor(files: readonly PrFile[], kind: string): string | undefined {
  const { touches, lines } = classOf(files, kind);
  const adversary = ADVERSARY_TOUCHES.filter((t) => touches.includes(t));
  if (adversary.length > 0) return `g10-adversary: ${adversary.join(", ")} touch`;
  if (lines === undefined) return "g10-review: changed lines unread";
  if (lines > SHEPHERD_CLASS_RULES.largeLines) return `g10-review: ${lines} changed lines`;
  return touches.includes("migration") ? "g10-review: store migration" : undefined;
}

/**
 * The G10 hold a PR needs at registration, adversary before review. A file list Shepherd cannot read whole (an API error or
 * a list past GitHub's cap) could hide any touch, so it takes the adversary class: failing closed means the seat reviews it.
 */
export async function g10HoldAt(port: GitHubPort, { repo, pr, kind }: HoldTarget): Promise<string | undefined> {
  try {
    return reasonFor(await port.listPrFiles(repo, pr), kind);
  } catch (error) {
    return `g10-adversary: changed files unread at registration (${error instanceof Error ? error.name : "error"})`;
  }
}

const wasG10Held = (store: ShepherdStore, runId: string): boolean => store.eventsOf(runId).some((event) => event.kind === "hold" && (event.reason?.startsWith("g10-") ?? false));

/**
 * Holds a new run for its G10 class. A run already held keeps the hold it has, so a seat's own hold or an inherited one
 * stands; a restart whose events carry a G10 hold had its class decided already, so a hold released there stays released.
 */
export async function applyRegistrationHold(port: GitHubPort, store: ShepherdStore, runId: string): Promise<string | undefined> {
  const registration = store.byRun(runId);
  if (!registration || registration.pr === null || registration.held || wasG10Held(store, runId)) return undefined;
  const mark = store.changeMark(runId);
  const reason = await g10HoldAt(port, { repo: registration.repo, pr: registration.pr, kind: registration.kind });
  if (reason === undefined) return undefined;
  return store.holdIfUnchanged(runId, mark, reason, { actor: SHEPHERD_ACTOR }) ? reason : undefined;
}
