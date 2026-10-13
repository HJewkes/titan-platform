import { FileListTruncatedError, type GitHubPort, type PrFile, type RepoSlug } from "@titan-design/github";
import { classifyPr, DEFAULT_CLASS_RULES, type ClassRules } from "@titan-design/review-panel";
import { SHEPHERD_ACTOR } from "./events.js";
import { holdClassOf } from "./g10-release.js";
import { reclassedUnread, UNREAD_FILES_PREFIX } from "./g10-reclass-events.js";
import { localPrFiles, prFilesOf, type PrFilesRead } from "./git-pr-files.js";
import { isAdversaryHold } from "./hold-slots.js";
import { isOwnerHold } from "./owner-hold-rows.js";
import { prChangedLines } from "./reviewer-roles.js";
import type { ShepherdStore } from "./store.js";

const SHEPHERD_MIGRATION_FILES = ["store.ts", "events.ts", "train.ts"].map((name) => `products/factory/src/shepherd/${name}`);
const MERGE_POLICY_FILES = ["g10-*.ts", "adversary-*.ts", "merge-evidence-gate.ts", "task-kind.ts", "registration-hold.ts", "release-head.ts"].map((name) => `**/${name}`);
/** Shepherd's hold, release, seat and reviewer-choice code, matched by exact path because the names are common elsewhere. */
const HOLD_COMMAND_FILES = ["commands.ts", "operator-hold.ts", "seats.ts", "release.ts", "reviewer-choice.ts"].map((name) => `products/factory/src/shepherd/${name}`);

/** Factory's store migrations and Shepherd's merge policy live in plain source files, which the panel's default globs miss. */
const SHEPHERD_CLASS_RULES: ClassRules = {
  ...DEFAULT_CLASS_RULES,
  policy: [...DEFAULT_CLASS_RULES.policy, ...MERGE_POLICY_FILES, ...HOLD_COMMAND_FILES],
  migration: [...DEFAULT_CLASS_RULES.migration, "**/store-migrations.ts", "**/*-migration*.ts", "**/*-store.ts", ...SHEPHERD_MIGRATION_FILES],
};

/** Each lost compare-and-swap means another hold or release landed; the run is read again and the G10 hold restacked on it. */
const CAS_ATTEMPTS = 5;

export { isUnreadRegistrationHold } from "./g10-reclass-events.js";

const ADVERSARY_TOUCHES = ["authority", "policy", "security"] as const;

interface HoldTarget {
  repo: RepoSlug;
  pr: number;
  kind: string;
  /** With `base`, the files come from Shepherd's git cache at this head instead of GitHub. */
  head?: string;
  base?: string;
}

interface HoldFiles {
  /** Reads a head's files from git; absent means the serve process's cached reader. */
  local?: PrFilesRead;
  /** The head to class instead of the registered one: the PR's head as a branch registration first saw it. */
  head?: string;
}

/**
 * The panel's class reads an absent kind as unread; only these touches name a hold, so an unread kind alone holds nothing.
 * The panel matches a file's new path only, so a rename's old path is classed as a file of its own: renaming a policy file
 * away keeps its class. Lines are counted from the real list, so the extra entries add none.
 */
function classOf(files: readonly PrFile[], kind: string): { touches: readonly string[]; lines: number | undefined } {
  const lines = prChangedLines(files, SHEPHERD_CLASS_RULES.largeLines);
  const changedFiles = files.flatMap(({ path, previousPath, additions, deletions }) => [
    { path, ...(previousPath !== undefined && { previousPath }), additions: additions ?? 0, deletions: deletions ?? 0 },
    ...(previousPath === undefined ? [] : [{ path: previousPath, additions: 0, deletions: 0 }]),
  ]);
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

/** A failed read is tried once more, since a transient error would otherwise cost a seat review; a list past the cap stays past it. */
async function filesWithRetry(port: GitHubPort, target: HoldTarget, local: PrFilesRead): Promise<PrFile[]> {
  try {
    return await prFilesOf(port, target, local);
  } catch (error) {
    if (error instanceof FileListTruncatedError) throw error;
    return prFilesOf(port, target, local);
  }
}

/**
 * The G10 hold a PR needs at registration, adversary before review. A file list Shepherd cannot read whole (an API error
 * twice, or a list past GitHub's cap) could hide any touch, so it takes the adversary class: failing closed means the seat
 * reviews it. Git's `-M` diff names a rename's old path as GitHub's list does, so both class a rename alike.
 */
export async function g10HoldAt(port: GitHubPort, target: HoldTarget, local: PrFilesRead = localPrFiles): Promise<string | undefined> {
  try {
    return reasonFor(await filesWithRetry(port, target, local), target.kind);
  } catch (error) {
    return `${UNREAD_FILES_PREFIX}${error instanceof Error ? error.name : "error"})`;
  }
}

const G10_STRENGTH: Readonly<Record<string, number>> = { "g10-review": 1, "g10-adversary": 2 };

const g10StrengthOf = (reason: string | null | undefined): number => G10_STRENGTH[holdClassOf(reason) ?? ""] ?? 0;

/**
 * True when a G10 hold at least as strong as `wanted` was placed on the run, so a weaker one placed or inherited never blocks
 * a stronger. An unread-files hold Shepherd re-classed decided no class, so a repeat registration may still escalate.
 */
function wasG10Held(store: ShepherdStore, runId: string, wanted: string): boolean {
  const events = store.eventsOf(runId);
  const reclassed = reclassedUnread(events);
  return events.some((event) => event.kind === "hold" && !reclassed.has(event) && g10StrengthOf(event.reason) >= g10StrengthOf(wanted));
}

/** True when the run holds or ever held a G10 hold; the reviewer it gets is picked by this, since a released hold still names the class. */
export const everG10Held = (store: ShepherdStore, runId: string): boolean =>
  g10StrengthOf(store.byRun(runId)?.holdReason) > 0 || store.eventsOf(runId).some((event) => event.kind === "hold" && g10StrengthOf(event.reason) > 0);

/**
 * The hold to place over the run's gating hold, or undefined when one as strong stands. A run keeps a second hold only
 * under a `g10-adversary` one, so a `g10-review` hold over another class would replace it; it goes in as adversary
 * instead, failing closed, and the other class waits under it. An owner-asked hold keeps its own slot, so it stacks nothing.
 */
export function stackedOver(gating: string | null, wanted: string): string | undefined {
  if (isAdversaryHold(gating)) return undefined;
  if (gating === null || isOwnerHold(gating) || isAdversaryHold(wanted)) return wanted;
  const gatingClass = holdClassOf(gating) ?? gating;
  if (gatingClass === holdClassOf(wanted)) return undefined;
  return `g10-adversary: ${wanted.slice(wanted.indexOf(":") + 1).trim()}, over a ${gatingClass} hold`;
}

/** Undefined when a G10 hold as strong as `wanted` was placed or released already, which decided the run's class. */
function holdToPlace(store: ShepherdStore, runId: string, wanted: string): string | undefined {
  const registration = store.byRun(runId);
  if (!registration || wasG10Held(store, runId, wanted)) return undefined;
  return stackedOver(registration.held ? (registration.holdReason ?? "") : null, wanted);
}

/**
 * Holds a run for its G10 class, stacked on any hold the run has, so the G10 hold outlasts a stall or an inherited hold.
 * Called at each registration and when a branch registration learns its PR, so a diff that grows is classed again. A
 * G10 hold as strong as the one wanted, placed or released before, decided the class already, so a released one stays
 * released; a weaker one does not stop an escalation. The file read is slow, so the hold is a compare-and-swap retried
 * on a fresh read of the run. A history that cannot be read holds `g10-adversary`, keeping an adversary hold in force.
 */
export async function applyRegistrationHold(port: GitHubPort, store: ShepherdStore, runId: string, files: HoldFiles = {}): Promise<string | undefined> {
  try {
    return await placeRegistrationHold(port, store, runId, files);
  } catch (error) {
    const reason = `g10-adversary: hold history unread at registration (${error instanceof Error ? error.name : "error"})`;
    return store.holdUnlessAdversary(runId, reason, { actor: SHEPHERD_ACTOR }) ? reason : undefined;
  }
}

/**
 * A run whose hold history cannot be read could have any class, so `applyRegistrationHold` holds it adversary instead,
 * unless an adversary hold already gates it: that hold, often a seat's with its reviewer, is kept as it stands.
 */
async function placeRegistrationHold(port: GitHubPort, store: ShepherdStore, runId: string, files: HoldFiles): Promise<string | undefined> {
  const registration = store.byRun(runId);
  if (!registration || registration.pr === null || wasG10Held(store, runId, "g10-adversary:")) return undefined;
  const head = files.head ?? registration.headSha ?? undefined;
  const target = { repo: registration.repo, pr: registration.pr, kind: registration.kind, ...(head !== undefined && { head }), ...(registration.base !== null && { base: registration.base }) };
  const wanted = await g10HoldAt(port, target, files.local);
  if (wanted === undefined) return undefined;
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
    const mark = store.changeMark(runId);
    const reason = holdToPlace(store, runId, wanted);
    if (reason === undefined) return undefined;
    if (store.holdIfUnchanged(runId, mark, reason, { actor: SHEPHERD_ACTOR })) return reason;
  }
  return undefined;
}
