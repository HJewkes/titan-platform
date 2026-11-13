import type { GitHubPort } from "@titan-design/github";
import type { StepRoute, WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { codeRoute, step } from "../workflows/land.js";
import { HEAD } from "./await-verdict.js";
import { generatedPathsFor } from "./remerge-carry.js";
import { isRepoKey } from "./seats.js";
import { BranchName, DIFF_ARGS, cacheFor, ensureCache, must, patchIdOf, reasonOf, remoteBase, serialized, type CacheHandle, type CarryOptions } from "./tree-carry.js";

/**
 * Records, per reviewed head, an id for the PR's own diff: the head against its merge base with the base branch. Two heads
 * with one id asked a reviewer to read the same change, however much of main the later one merged (TP-5592).
 */
export const OWN_DIFF_STEP = "sh-own-diff";

/** A fixer regenerates these rather than writes them, so a head that only re-stamped them changed nothing a reviewer reads. */
const REGENERATED = ["products/factory/src/registry/closure.lock.json", "products/factory/src/registry/attestations/**"];

const Sha = z.string().regex(HEAD, "must be 40 lowercase hex characters");
const OwnDiffInputSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), baseRef: BranchName, head: Sha });
type OwnDiffInput = z.infer<typeof OwnDiffInputSchema>;
const OwnDiffStepInputSchema = z.object({ repo: z.string().refine(isRepoKey, "must be owner/repo"), pr: z.number().int().positive(), head: Sha });
type OwnDiffStepInput = z.infer<typeof OwnDiffStepInputSchema>;

/** `id` is the own diff's patch id and `base` the merge base it was read against; `unread` says, from a fixed vocabulary, why neither was read. */
const OwnDiffResultSchema = z.union([z.object({ id: z.string().min(1), base: Sha }), z.object({ unread: z.string().min(1) })]);
export type OwnDiffResult = z.infer<typeof OwnDiffResultSchema>;

const excluded = (repo: string): string[] => [...generatedPathsFor(repo), ...REGENERATED].map((path) => `:(exclude,glob)${path}`);

async function readOwnDiff(cache: CacheHandle, input: OwnDiffInput, signal?: AbortSignal): Promise<OwnDiffResult> {
  const { git, dir, url } = cache;
  await ensureCache(cache, signal);
  await must(git, dir, ["fetch", "--no-tags", "--no-write-fetch-head", "--quiet", url, input.head, `+refs/heads/${input.baseRef}:${remoteBase(input.baseRef)}`], signal);
  const base = await must(git, dir, ["merge-base", input.head, remoteBase(input.baseRef)], signal);
  const diff = await must(git, dir, [...DIFF_ARGS, base, input.head, "--", ".", ...excluded(input.repo)], signal);
  return { id: patchIdOf(diff), base };
}

/** The head's own-diff id; any failure, from bad input to a refused fetch, answers `unread` with its reason and never throws. */
export async function ownDiff(raw: unknown, options: CarryOptions): Promise<OwnDiffResult> {
  const parsed = OwnDiffInputSchema.safeParse(raw);
  if (!parsed.success) return { unread: "invalid own-diff input" };
  try {
    const cache = cacheFor(parsed.data.repo, options);
    return await serialized(cache.dir, () => readOwnDiff(cache, parsed.data, options.signal));
  } catch (error) {
    options.signal?.throwIfAborted();
    return { unread: reasonOf(error) };
  }
}

/** The PR's base branch is read live, since a stacked PR is retargeted; a failed read is unread like any other. */
async function ownDiffOfPr(port: Pick<GitHubPort, "getPr">, input: OwnDiffStepInput, options: CarryOptions): Promise<OwnDiffResult> {
  const pr = await port.getPr(input.repo, input.pr).catch(() => undefined);
  if (pr === undefined) return { unread: "the PR's base branch was not read" };
  return ownDiff({ repo: input.repo, baseRef: pr.baseRef, head: input.head }, options);
}

export function ownDiffRoute(now: () => number, port: Pick<GitHubPort, "getPr">, options: Omit<CarryOptions, "signal">): StepRoute {
  return codeRoute(OWN_DIFF_STEP, now, (raw: unknown, signal) => ownDiffOfPr(port, OwnDiffStepInputSchema.parse(raw), { ...options, signal }));
}

export interface OwnDiffWiring {
  /** Records each reviewed head's own-diff id for the scorecard; absent records none, and the intent says so. */
  ownDiff?: true;
}

/** The intent records whether the host wired the step, so a run recorded before it, or without it, replays with no own-diff step. */
export const ownDiffOn = (intent: Readonly<Record<string, unknown>>): boolean => intent.ownDiff === true;

/** Recorded right after the review intent, for the scorecard alone: nothing reads it to decide. */
export async function recordOwnDiff(ctx: WorkflowContext, input: OwnDiffStepInput): Promise<void> {
  await step(ctx, `${OWN_DIFF_STEP}:${input.head}`, input, OwnDiffResultSchema);
}
