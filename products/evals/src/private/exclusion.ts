import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Layer 1: cases come only from these repos (bare names; `owner/` is ignored). */
const ENGINEERING_REPOS = ["titan-platform", "agent-chat", "relay", "codewatch", "active-work"] as const;
/** Layer 1: a task is joined only from these initiatives. */
const ENGINEERING_INITIATIVES = ["titan-platform", "codewatch", "relay", "claude-channels"] as const;
/** Task-id prefix to its engineering initiative; a prefix not listed is never joined. */
const ENGINEERING_TASK_PREFIXES: Readonly<Record<string, string>> = {
  TP: "titan-platform",
  AW: "titan-platform",
  C: "codewatch",
  R: "relay",
  CC: "claude-channels",
};

/** Layer 2: every initiative outside the allowlist, and the task-id prefixes its task files use. */
interface PrivateMarkers {
  slugs: readonly string[];
  prefixes: readonly string[];
}

export interface ExclusionPolicy {
  repos: readonly string[];
  initiatives: readonly string[];
  markers: PrivateMarkers;
}

/** What the exclusion reads of a case: where it came from, and everything it would write. */
interface ExclusionSubject {
  id: string;
  repo: string;
  taskInitiative?: string | null;
  body: unknown;
}

type ExclusionReason = "private-repo" | "private-task" | "private-marker";

const repoName = (repo: string): string => repo.slice(repo.lastIndexOf("/") + 1);

/** Layer 1 for task joins: the initiative a task id may be read from, or undefined when it must not be opened. */
export function engineeringInitiativeOf(taskId: string, initiatives: readonly string[] = ENGINEERING_INITIATIVES): string | undefined {
  const initiative = ENGINEERING_TASK_PREFIXES[taskId.split("-")[0] ?? ""];
  return initiative !== undefined && initiatives.includes(initiative) ? initiative : undefined;
}

function taskPrefixes(initiativeDir: string): string[] {
  const dirs = [join(initiativeDir, "tasks"), join(initiativeDir, "tasks", "archive")].filter((dir) => existsSync(dir));
  return dirs.flatMap((dir) => readdirSync(dir).flatMap((file) => /^([A-Z]+)-\d+\.yml$/.exec(file)?.[1] ?? []));
}

/** Every initiative dir (one holding brief.md) outside the allowlist is private, so new initiatives are covered on creation. */
export function readPrivateMarkers(activeWorkRoot: string, initiatives: readonly string[] = ENGINEERING_INITIATIVES): PrivateMarkers {
  const slugs = readdirSync(activeWorkRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !initiatives.includes(entry.name) && existsSync(join(activeWorkRoot, entry.name, "brief.md")))
    .map((entry) => entry.name)
    .sort();
  const prefixes = new Set(slugs.flatMap((slug) => taskPrefixes(join(activeWorkRoot, slug))));
  for (const known of Object.keys(ENGINEERING_TASK_PREFIXES)) prefixes.delete(known);
  return { slugs, prefixes: [...prefixes].sort() };
}

export function defaultPolicy(activeWorkRoot: string): ExclusionPolicy {
  return { repos: ENGINEERING_REPOS, initiatives: ENGINEERING_INITIATIVES, markers: readPrivateMarkers(activeWorkRoot) };
}

/** Bare slugs never match: `/status` is a daemon endpoint in these repos, so only path, citation and field forms count. */
export function privateHits(text: string, markers: PrivateMarkers): string[] {
  const slugHits = markers.slugs.filter(
    (slug) => text.includes(`active-work/${slug}/`) || text.includes(`[from \`${slug}\`]`) || text.includes(`initiative: ${slug}\n`) || text.includes(`"initiative":"${slug}"`),
  );
  if (markers.prefixes.length === 0) return slugHits;
  const ids = new RegExp(`\\b(?:${markers.prefixes.join("|")})-\\d+\\b`, "g");
  return [...slugHits, ...new Set(text.match(ids) ?? [])];
}

function exclusionReason(subject: ExclusionSubject, policy: ExclusionPolicy): ExclusionReason | undefined {
  if (!policy.repos.includes(repoName(subject.repo))) return "private-repo";
  if (subject.taskInitiative != null && !policy.initiatives.includes(subject.taskInitiative)) return "private-task";
  return privateHits(JSON.stringify(subject.body), policy.markers).length > 0 ? "private-marker" : undefined;
}

interface Filtered<T extends ExclusionSubject> {
  kept: T[];
  excluded: Partial<Record<ExclusionReason, number>>;
}

/** Layer 2: drops each private subject and counts it by reason. */
export function filterPrivate<T extends ExclusionSubject>(subjects: readonly T[], policy: ExclusionPolicy): Filtered<T> {
  const kept: T[] = [];
  const excluded: Partial<Record<ExclusionReason, number>> = {};
  for (const subject of subjects) {
    const reason = exclusionReason(subject, policy);
    if (reason === undefined) kept.push(subject);
    else excluded[reason] = (excluded[reason] ?? 0) + 1;
  }
  return { kept, excluded };
}

/** Layer 3: re-checks what is about to be written and aborts the build on any hit. */
export function assertNoPrivate(subjects: readonly ExclusionSubject[], policy: ExclusionPolicy): void {
  for (const subject of subjects) {
    const reason = exclusionReason(subject, policy);
    if (reason !== undefined) throw new Error(`private case refused (${reason}): ${subject.id}`);
  }
}

interface ExclusionLayers {
  filter: typeof filterPrivate;
  assert: typeof assertNoPrivate;
}

interface SelfTestResult {
  ok: boolean;
  /** Ids the filter let through; only the clean case should be here. */
  survivors: string[];
  /** Planted ids the final assertion failed to refuse on its own. */
  assertMissed: string[];
  privateInitiatives: number;
}

const PLANTED_SLUG = "selftest-private-initiative";
const PLANTED_PREFIX = "STPX";

/** One clean case and one per private route: a path, a repo, a task initiative and a task id. */
function plantedCases(policy: ExclusionPolicy): { clean: ExclusionSubject; planted: ExclusionSubject[] } {
  const repo = `owner/${policy.repos[0] ?? "none"}`;
  return {
    clean: { id: "selftest-clean", repo, body: { note: "GET /status returns 200" } },
    planted: [
      { id: "selftest-private-path", repo, body: { note: `see active-work/${PLANTED_SLUG}/brief.md` } },
      { id: "selftest-private-repo", repo: "owner/selftest-private-repo", body: {} },
      { id: "selftest-private-task", repo, taskInitiative: PLANTED_SLUG, body: {} },
      { id: "selftest-private-task-id", repo, body: { note: `fixes ${PLANTED_PREFIX}-12` } },
    ],
  };
}

function refuses(assert: ExclusionLayers["assert"], subject: ExclusionSubject, policy: ExclusionPolicy): boolean {
  try {
    assert([subject], policy);
    return false;
  } catch {
    return true;
  }
}

/** Passes only when the filter keeps exactly the clean case and the final assertion refuses every planted case by itself. */
export function selfTest(policy: ExclusionPolicy, layers: ExclusionLayers = { filter: filterPrivate, assert: assertNoPrivate }): SelfTestResult {
  const markers = { slugs: [...policy.markers.slugs, PLANTED_SLUG], prefixes: [...policy.markers.prefixes, PLANTED_PREFIX] };
  const planting = { ...policy, markers };
  const { clean, planted } = plantedCases(planting);
  const survivors = layers.filter([clean, ...planted], planting).kept.map((subject) => subject.id);
  const assertMissed = planted.filter((subject) => !refuses(layers.assert, subject, planting)).map((subject) => subject.id);
  const cleanRefused = refuses(layers.assert, clean, planting);
  const ok = survivors.length === 1 && survivors[0] === clean.id && assertMissed.length === 0 && !cleanRefused;
  return { ok, survivors, assertMissed, privateInitiatives: policy.markers.slugs.length };
}
