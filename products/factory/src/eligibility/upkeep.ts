import { posix } from "node:path";
import type { Bet, Task } from "@titan-design/pm";
import { z } from "zod";
import type { UpkeepRules } from "./shadow/rule-file.js";
import upkeepPathsJson from "./upkeep-paths.json" with { type: "json" };

/*
 * The upkeep cap (operating model PROPOSAL 2.2, TP-5755 S4): when upkeep took a quarter of the lane's recent changes,
 * upkeep work waits. The share is measured from the paths merged PRs changed, never from a filer's class tag, because a
 * tag says what the filer meant and the paths say what the week was spent on. Pure; the reads live in upkeep-signals.ts.
 */

const UpkeepPathsSchema = z.object({ upkeep: z.array(z.string().min(1)), testOnly: z.array(z.string().min(1)) }).strict();

type UpkeepPaths = z.infer<typeof UpkeepPathsSchema>;

/** The checked-in path classes: a change to them is reviewed in the pull request that makes it. */
const UPKEEP_PATHS: UpkeepPaths = UpkeepPathsSchema.parse(upkeepPathsJson);

/** One merged lane PR and every path it changed. */
export interface MergedPrFiles {
  /** `owner/repo#n`. */
  pr: string;
  files: readonly string[];
}

export type UpkeepRead = { ok: true; prs: readonly MergedPrFiles[] } | { ok: false; why: string };

interface UpkeepShare {
  upkeepFiles: number;
  allFiles: number;
  prs: number;
  share: number;
}

export interface UpkeepHold {
  task: string;
  stage: "upkeep";
  codes: ("upkeep-cap" | "signal-unreadable")[];
  details: string[];
  numbers?: Record<string, number>;
}

const matchesAny = (path: string, globs: readonly string[]): boolean => globs.some((glob) => posix.matchesGlob(path, glob));

/** A test file is upkeep only in a PR that changed nothing else; beside product code it tests that product. */
function upkeepFileCount(files: readonly string[], paths: UpkeepPaths = UPKEEP_PATHS): number {
  const testOnlyPr = files.length > 0 && files.every((file) => matchesAny(file, paths.testOnly));
  return files.filter((file) => testOnlyPr || matchesAny(file, paths.upkeep)).length;
}

function upkeepShare(prs: readonly MergedPrFiles[], paths: UpkeepPaths = UPKEEP_PATHS): UpkeepShare {
  const upkeepFiles = prs.reduce((total, pr) => total + upkeepFileCount(pr.files, paths), 0);
  const allFiles = prs.reduce((total, pr) => total + pr.files.length, 0);
  return { upkeepFiles, allFiles, prs: prs.length, share: allFiles === 0 ? 0 : upkeepFiles / allFiles };
}

/** Upkeep by its tag, or untagged work toward one of the factory's own outcomes; product work is never capped. */
export function capsTask(task: Task, bet: Bet, rules: UpkeepRules): boolean {
  if (task.class !== undefined) return task.class === "upkeep";
  return rules.factoryOutcomes.includes(bet.outcome);
}

interface UpkeepInput {
  initiative: string;
  candidates: readonly { task: Task; bet: Bet }[];
  read: UpkeepRead;
  rules: UpkeepRules;
  paths?: UpkeepPaths;
}

/** Holds each capped candidate at or past the cap; an unread share holds them too, so an outage never reads as room. */
export function upkeepHolds({ initiative, candidates, read, rules, paths }: UpkeepInput): UpkeepHold[] {
  const keys = candidates.filter(({ task, bet }) => capsTask(task, bet, rules)).map(({ task }) => `${initiative}/${task.id}`);
  if (keys.length === 0) return [];
  if (!read.ok) return keys.map((task) => ({ task, stage: "upkeep", codes: ["signal-unreadable"], details: [`upkeep share unread: ${read.why}`] }));
  const share = upkeepShare(read.prs, paths);
  if (share.share < rules.capShare) return [];
  const numbers = { ...share, cap: rules.capShare };
  const detail = `upkeep changed ${share.upkeepFiles} of ${share.allFiles} files across ${share.prs} PRs merged in ${rules.windowDays} days, at or past the cap of ${rules.capShare}`;
  return keys.map((task) => ({ task, stage: "upkeep", codes: ["upkeep-cap"], details: [detail], numbers }));
}
