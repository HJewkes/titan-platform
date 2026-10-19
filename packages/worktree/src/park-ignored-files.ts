import { gitOrNull } from "./git.js";
import { isRegenerable } from "./unsaved-work.js";

/** A fresh package-owned ignored-file observation, not caller-supplied clearance. */
export interface ParkIgnoredFilesObservation {
  readonly worktree: string;
  readonly entries: readonly string[];
}

/** Product policy over ignored files only; dirty work and failed reads cannot be waived. */
export interface ParkIgnoredFilesPolicy {
  readonly expandDirectories?: boolean;
  readonly protectedEntries: (observation: ParkIgnoredFilesObservation) => readonly string[];
  readonly formatRefusal?: (observation: ParkIgnoredFilesObservation) => string;
}

export type ParkFileObserver = () => Promise<string | undefined>;

interface Descriptor {
  readonly expandDirectories: boolean;
  readonly protectedEntries: ParkIgnoredFilesPolicy["protectedEntries"];
  readonly formatRefusal: ParkIgnoredFilesPolicy["formatRefusal"];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const classifier = (value: unknown): value is ParkIgnoredFilesPolicy["protectedEntries"] =>
  typeof value === "function";
const formatter = (value: unknown): value is NonNullable<ParkIgnoredFilesPolicy["formatRefusal"]> =>
  typeof value === "function";

function descriptor(value: unknown): Descriptor | undefined {
  if (!record(value)) return undefined;
  const expand = value.expandDirectories;
  const classify = value.protectedEntries;
  const format = value.formatRefusal;
  if ((expand !== undefined && typeof expand !== "boolean") ||
      !classifier(classify) || (format !== undefined && !formatter(format))) return undefined;
  return Object.freeze({
    expandDirectories: expand === true,
    protectedEntries: classify,
    formatRefusal: format,
  });
}

const snapshot = (worktree: string, entries: readonly string[]): ParkIgnoredFilesObservation =>
  Object.freeze({ worktree, entries: Object.freeze([...entries]) });

const refusal = (worktree: string, entries: readonly string[]): string =>
  "ignored files in " + worktree + " would be deleted (" + entries.slice(0, 3).join(", ") + "); ignored-file policy did not permit removal";

function protectedSubset(value: unknown, observed: readonly string[]): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    if (value instanceof Promise) void value.catch(() => undefined);
    return undefined;
  }
  const then: unknown = Reflect.get(value, "then");
  if (typeof then === "function") return undefined;
  const length: unknown = value.length;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return undefined;
  const selected = new Set<string>();
  for (let index = 0; index < length; index++) {
    if (!Object.hasOwn(value, index)) return undefined;
    const entry: unknown = value[index];
    if (typeof entry !== "string" || !observed.includes(entry) || selected.has(entry)) return undefined;
    selected.add(entry);
  }
  return Object.freeze(observed.filter(entry => selected.has(entry)));
}

function formattedRefusal(policy: Descriptor, observation: ParkIgnoredFilesObservation): string {
  const fallback = refusal(observation.worktree, observation.entries);
  try {
    const detail: unknown = policy.formatRefusal?.(observation);
    return typeof detail === "string" && detail.trim() !== "" ? detail : fallback;
  } catch {
    return fallback;
  }
}

interface Candidates {
  readonly entries: readonly string[];
  readonly failed: readonly string[];
}

async function expandedCandidates(worktree: string, ignored: string, expand: boolean): Promise<Candidates> {
  const entries: string[] = [];
  const failed: string[] = [];
  for (const entry of ignored.split("\n").filter(entry => entry !== "" && !isRegenerable(entry))) {
    if (!expand || !entry.endsWith("/")) entries.push(entry);
    else {
      const listed = await gitOrNull(["ls-files", "--others", "--ignored", "--exclude-standard", "--", entry], worktree);
      if (listed === null) failed.push(entry);
      else entries.push(...listed.split("\n").filter(Boolean));
    }
  }
  return {
    entries: Object.freeze([...new Set(entries.filter(entry => !isRegenerable(entry)))]),
    failed: Object.freeze([...new Set(failed)]),
  };
}

async function observePolicy(worktree: string, policy: Descriptor): Promise<string | undefined> {
  const status = await gitOrNull(["status", "--porcelain", "-uall"], worktree);
  if (status === null) return "could not read git status in " + worktree;
  if (status !== "") return "uncommitted or untracked changes in " + worktree;
  const ignored = await gitOrNull(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"], worktree);
  if (ignored === null) return "could not list ignored files in " + worktree;
  const candidates = await expandedCandidates(worktree, ignored, policy.expandDirectories);
  if (candidates.failed.length > 0) return refusal(worktree, candidates.failed);
  const observation = snapshot(worktree, candidates.entries);
  const result: unknown = policy.protectedEntries(observation);
  const protectedEntries = protectedSubset(result, observation.entries);
  if (protectedEntries === undefined) return "invalid ignored-file policy result in " + worktree + "; not parked";
  return protectedEntries.length === 0 ? undefined : formattedRefusal(policy, snapshot(worktree, protectedEntries));
}

/** Capture the descriptor once; errors can only refuse, never replace actual Git observations. */
export function prepareIgnoredFiles(value: unknown, worktree: string): ParkFileObserver | { reason: string } {
  try {
    const policy = descriptor(value);
    if (policy === undefined) return { reason: "invalid ignored-file policy in " + worktree + "; not parked" };
    return async () => {
      try {
        return await observePolicy(worktree, policy);
      } catch {
        return "could not apply ignored-file policy in " + worktree + "; not parked";
      }
    };
  } catch {
    return { reason: "invalid ignored-file policy in " + worktree + "; not parked" };
  }
}
