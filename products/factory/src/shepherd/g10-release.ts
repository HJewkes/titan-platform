import type { RepoSlug } from "@titan-design/github";
import type { SourceTextLocator } from "@titan-design/session-read";
import type { WorkflowContext } from "@titan-design/workflow";
import { z } from "zod";
import { stepIdMatches, type StepDeclaration } from "../definition.js";
import { codeRoute, step, type CiSnapshot } from "../workflows/land.js";
import { SHEPHERD_ACTOR } from "./events.js";
import type { TakeRecheck } from "./hold.js";
import type { PanelMerge, ShepherdDeps, Verdict } from "./phases.js";
import { pinnedPaths } from "./pr-changed-paths.js";
import { OWNER_PACKET_FILES } from "./signoffs.js";
import { narrowToRegistration } from "./registration-policy.js";
import { separateLineages, type LineageRow } from "./reviewer-lineage.js";
import type { ShepherdStore } from "./store.js";

export const G10_RELEASE_STEP = "sh-g10-release";
export const G10_RELEASE_STEPS: readonly StepDeclaration[] = [{ id: G10_RELEASE_STEP, kind: "dispatch" }];

/**
 * A hold's class is the text before the first colon of its reason, matched exactly: no trimming. `g10-review` releases on an opus MERGE;
 * `g10-adversary` (authority, merge-policy and security PRs) only on two MERGEs under `shepherd.gateReset.twoMergeRelease`; every
 * other class waits for a seat.
 */
const G10_REVIEW_CLASS = "g10-review";
const G10_ADVERSARY_CLASS = "g10-adversary";

/**
 * Decision 422(1)'s stopgap, superseded at M5: D-M5-03 (TP-3153) deletes it with the hold slots, and its merge-up carry goes at M3
 * with 341(1) (D-M3-19, TP-3147). `shadow` records what it would release and releases nothing.
 */
export const TWO_MERGE_RULE = "g10-adversary/two-merge";
export type TwoMergeMode = "shadow" | "on";

export const holdClassOf = (reason: string | null | undefined): string | undefined => (reason?.includes(":") ? reason.slice(0, reason.indexOf(":")) : undefined);

/** Profiles whose model is Opus: the G10 review is an opus reviewer's, and the profile name is all Shepherd can read of the model. */
const OPUS_PROFILES: ReadonlySet<string> = new Set(["bd-reviewer"]);
export const isOpusProfile = (profile: string | undefined): boolean => profile !== undefined && (OPUS_PROFILES.has(profile) || /(^|[-_])opus([-_]|$)/i.test(profile));

const Identity = z.looseObject({ agentId: z.string(), sessionId: z.string() });

/** The reviewer's answer at one head and where it was written: the verdict ref a release records. */
const G10VerdictSchema = z.looseObject({ value: z.string(), head: z.string(), reviewer: Identity, locator: z.custom<SourceTextLocator>((value) => typeof value === "object" && value !== null) });
export type G10Verdict = z.infer<typeof G10VerdictSchema>;

interface G10Run {
  held: boolean;
  holdReason: string | null;
  /** A hold that names a reviewer waits for that reviewer's MERGE, so Shepherd's own never releases it. */
  holdReviewer?: string | null;
  /** Whether the gating hold's placing is on record; a hold Shepherd cannot trace may be one the owner assigned, so it never releases itself. */
  recorded?: boolean;
}

interface G10Checks {
  head: string;
  green: boolean;
}

const MergeUpSchema = z.looseObject({ fromHead: z.string(), head: z.string() });
/** A clean merge-up the run recorded from the reviewed head to the head it made; see `merge-up-carry.ts`. */
type MergeUp = z.infer<typeof MergeUpSchema>;

/** The head a MERGE stands at: the head it was written at, or the head a clean merge-up of that head made. */
const standsAt = (verdict: G10Verdict, mergeUp: MergeUp | undefined): string => (mergeUp?.fromHead === verdict.head ? mergeUp.head : verdict.head);

/**
 * The owner assigns a review to a person as an `owner-review` hold or a hold naming `--reviewer` (TP-3083). A hold whose placing is not on
 * record, or whose history cannot be read, may be either, so it fails closed.
 */
const maybeAssigned = (run: G10Run): boolean => Boolean(run.holdReviewer) || run.recorded !== true;

/**
 * True when the run is held as `g10-review`, on record with no named reviewer, and an opus reviewer's MERGE stands at the PR's head as read
 * now, with the required checks green at that same head. The head is the caller's fresh read, never the run's recorded one.
 */
export function satisfiesG10(run: G10Run, verdict: G10Verdict | undefined, prHead: string, checks: G10Checks, reviewProfile: string | undefined, mergeUp?: MergeUp): boolean {
  if (!run.held || holdClassOf(run.holdReason) !== G10_REVIEW_CLASS || maybeAssigned(run)) return false;
  if (!isOpusProfile(reviewProfile)) return false;
  return verdict?.value === "MERGE" && standsAt(verdict, mergeUp) === prHead && checks.green && checks.head === prHead;
}

/** One Shepherd reviewer's MERGE as the two-MERGE rule reads it: the verdict ref, and the profile Shepherd spawned it at. */
const ReviewerMergeSchema = z.looseObject({ verdict: G10VerdictSchema, profile: z.string() });
type ReviewerMerge = z.infer<typeof ReviewerMergeSchema>;

interface TwoMerge {
  correctness: ReviewerMerge;
  adversary: ReviewerMerge;
  mergeUp?: MergeUp;
}

/**
 * Two reviewers, not one twice. Decision 457 runs both at the same profile, so the profile no longer tells them apart; the
 * roster must prove their conversations separate (D7). `roster` undefined means it was not read, which proves nothing.
 */
const independent = ({ correctness, adversary }: TwoMerge, roster: readonly LineageRow[] | undefined): boolean =>
  isOpusProfile(correctness.profile) && roster !== undefined && separateLineages(correctness.verdict.reviewer, adversary.verdict.reviewer, roster);

/** `files` undefined means the list was not read whole, which could hide the rule file, so it never releases. */
const clearOfOwnerPacket = (files: readonly string[] | undefined): files is readonly string[] => files !== undefined && !files.some((path) => OWNER_PACKET_FILES.includes(path));

/**
 * True when the run is held as `g10-adversary`, on record with no named reviewer (418(2)), and both Shepherd's opus correctness MERGE
 * and its adversary MERGE stand at the PR's head as read now, from reviewers the roster shows share no conversation, with the required
 * checks green there and no change to the owner's rule file in the diff. A MERGE stands at the head it was written at, or the head a recorded clean merge-up of it made (341(1)).
 */
export function satisfiesTwoMerge(run: G10Run, merges: TwoMerge, prHead: string, checks: G10Checks, files: readonly string[] | undefined, roster: readonly LineageRow[] | undefined): boolean {
  if (!run.held || holdClassOf(run.holdReason) !== G10_ADVERSARY_CLASS || maybeAssigned(run)) return false;
  if (!independent(merges, roster) || !clearOfOwnerPacket(files)) return false;
  const stands = [merges.correctness, merges.adversary].every(({ verdict }) => verdict.value === "MERGE" && standsAt(verdict, merges.mergeUp) === prHead);
  return stands && checks.green && checks.head === prHead;
}

const ChecksSchema = z.looseObject({ head: z.string(), green: z.boolean() });
const G10ReleaseInput = z.looseObject({ runId: z.string(), repo: z.string(), pr: z.number(), head: z.string(), verdict: G10VerdictSchema, reviewerProfile: z.string(), checks: ChecksSchema, mergeUp: MergeUpSchema.optional() });
const TwoMergeInput = z.looseObject({
  ...{ runId: z.string(), repo: z.string(), pr: z.number(), head: z.string(), rule: z.literal(TWO_MERGE_RULE) },
  ...{ correctness: ReviewerMergeSchema, adversary: ReviewerMergeSchema, checks: ChecksSchema, mergeUp: MergeUpSchema.optional() },
});
const G10ReleaseResult = z.looseObject({ released: z.boolean(), head: z.string(), verdict: G10VerdictSchema.optional(), wouldRelease: z.boolean().optional() });

/** True when the run recorded a hold event under exactly `reason`; false when it did not or the history cannot be read. */
function holdRecorded(store: ShepherdStore, runId: string, reason: string | null): boolean {
  try {
    return reason !== null && store.eventsOf(runId).some((event) => event.kind === "hold" && event.reason === reason);
  } catch {
    return false;
  }
}

/** The run's gating hold as the release judges it, read after the PR head. */
function heldRun(store: ShepherdStore, runId: string): G10Run & { holdReason: string | null } {
  const registration = store.byRun(runId);
  const holdReason = registration?.holdReason ?? null;
  return { held: registration?.held ?? false, holdReason, holdReviewer: registration?.holdReviewer ?? null, recorded: holdRecorded(store, runId, holdReason) };
}

async function releaseOnReview(deps: ShepherdDeps, raw: unknown) {
  const input = G10ReleaseInput.parse(raw);
  const prHead = (await deps.port.getPr(input.repo, input.pr)).headSha;
  const store = deps.store.get();
  const run = heldRun(store, input.runId);
  const judged = satisfiesG10(run, input.verdict, prHead, input.checks, input.reviewerProfile, input.mergeUp);
  const released = judged && run.holdReason !== null && store.releaseIfHeld(input.runId, run.holdReason);
  return { released, head: prHead, ...(released && { verdict: input.verdict }) };
}

/** The roster as the lineage check reads it; an unwired or failed read is undefined, so the hold stays. */
async function lineageRoster(deps: ShepherdDeps): Promise<readonly LineageRow[] | undefined> {
  const read = await deps.roster?.read();
  return read?.kind === "known" ? read.rows : undefined;
}

/**
 * The files are re-read pinned to the head just read, so a push between the reads leaves them unread. The release event carries the
 * head, which `adversary-anchor.ts` takes as the released head a later merge-up must stay on; the step records both refs and the rule.
 */
async function releaseOnTwoMerges(deps: ShepherdDeps, mode: TwoMergeMode | undefined, raw: unknown) {
  const input = TwoMergeInput.parse(raw);
  const target = { repo: input.repo, pr: input.pr };
  const roster = await lineageRoster(deps);
  const prHead = (await deps.port.getPr(target.repo, target.pr)).headSha;
  const files = await pinnedPaths(deps.port, { ...target, head: prHead }, prHead);
  const store = deps.store.get();
  const run = heldRun(store, input.runId);
  const judged = satisfiesTwoMerge(run, input, prHead, input.checks, files.unread === undefined ? files.paths : undefined, roster);
  const released = judged && mode === "on" && run.holdReason !== null && store.releaseIfHeld(input.runId, run.holdReason, { actor: SHEPHERD_ACTOR, headSha: prHead });
  const refs = { rule: TWO_MERGE_RULE, correctness: input.correctness, adversary: input.adversary };
  return { released, head: prHead, mode: mode ?? "off", ...(released && refs), ...(judged && mode === "shadow" && { wouldRelease: true, ...refs }) };
}

const isTwoMergeAsk = (raw: unknown): boolean => typeof raw === "object" && raw !== null && "rule" in raw && raw.rule === TWO_MERGE_RULE;

/**
 * The hold is read after the PR head, and released only if it is still held under the reason that was judged, so a re-hold in between
 * stands. `twoMerge` is `shepherd.gateReset.twoMergeRelease`, read per step when a function; absent (off) never releases a g10-adversary hold.
 */
export function g10ReleaseRoutes(deps: ShepherdDeps, twoMerge?: TwoMergeMode | (() => TwoMergeMode | undefined)) {
  const modeNow = () => (typeof twoMerge === "function" ? twoMerge() : twoMerge);
  return [codeRoute(G10_RELEASE_STEP, deps.now, (raw: unknown) => (isTwoMergeAsk(raw) ? releaseOnTwoMerges(deps, modeNow(), raw) : releaseOnReview(deps, raw)))];
}

/** Marks a MERGE as the verdict of the reviewer Shepherd spawned with `profile`; an external, resumed or carried verdict has none. */
export function withReviewerProfile(verdict: Verdict, profile: string | undefined): Verdict {
  return verdict.kind === "MERGE" && profile !== undefined ? { ...verdict, reviewerProfile: profile } : verdict;
}

interface G10WorkflowRun {
  ctx: WorkflowContext;
  target: { repo: string; pr: number };
  reviews: ReadonlyMap<string, Verdict>;
  lastCi?: CiSnapshot;
}

const EvidenceRecord = z.looseObject({ record: z.looseObject({ head: z.string(), verdictLocator: G10VerdictSchema.shape.locator, reviewer: Identity, carry: z.unknown().optional() }) });

/** The verdict ref of a MERGE the reviewer wrote at exactly this head; a verdict carried over from another head has none. */
function mergeRefAt(verdict: Verdict | undefined, head: string): G10Verdict | undefined {
  if (verdict?.kind !== "MERGE") return undefined;
  const evidence = EvidenceRecord.safeParse(verdict.evidence);
  if (!evidence.success || evidence.data.record.carry != null || evidence.data.record.head !== head) return undefined;
  const { verdictLocator, reviewer } = evidence.data.record;
  return { value: "MERGE", head, reviewer, locator: verdictLocator };
}

/** Verdicts that already released a hold in this run; a replay rebuilds the set from the recorded steps, so a re-hold waits for a verdict not yet used. */
const used = new WeakMap<WorkflowContext, Set<string>>();

interface Judged {
  verdict: G10Verdict;
  reviewerProfile: string;
  mergeUp?: MergeUp;
}

type MergeVerdict = Extract<Verdict, { kind: "MERGE" }>;

/** The MERGE at the reviewed head behind this one: the head itself, or the one a recorded clean merge-up carried to it; any other carry has none. */
function reviewedMergeAt(reviews: ReadonlyMap<string, Verdict>, head: string): { source: MergeVerdict; fromHead: string; mergeUp?: MergeUp } | undefined {
  const merge = reviews.get(head);
  if (merge?.kind !== "MERGE") return undefined;
  const fromHead = merge.mergeUpFrom ?? head;
  const source = reviews.get(fromHead);
  if (source?.kind !== "MERGE") return undefined;
  return { source, fromHead, ...(fromHead !== head && { mergeUp: { fromHead, head } }) };
}

/** The opus MERGE written at this head, or at the reviewed head a recorded clean merge-up carried to it. */
function judgedAt(reviews: ReadonlyMap<string, Verdict>, head: string): Judged | undefined {
  const reviewed = reviewedMergeAt(reviews, head);
  const verdict = reviewed && mergeRefAt(reviewed.source, reviewed.fromHead);
  const reviewerProfile = reviewed?.source.reviewerProfile;
  if (!reviewed || !verdict || reviewerProfile === undefined || !isOpusProfile(reviewerProfile)) return undefined;
  return { verdict, reviewerProfile, ...(reviewed.mergeUp && { mergeUp: reviewed.mergeUp }) };
}

const LocatorSchema = G10VerdictSchema.shape.locator;

/** The adversary member's own MERGE written at `head`, with the profile Shepherd spawned it at; one recorded without either has none. */
function adversaryMergeAt(panel: PanelMerge | undefined, head: string): ReviewerMerge | undefined {
  const member = panel?.members.find((m) => m.shape === "adversary" && m.verdict === "MERGE" && m.head === head);
  const locator = LocatorSchema.safeParse(member?.locator);
  if (!member?.profile || !locator.success) return undefined;
  return { verdict: { value: "MERGE", head, reviewer: { agentId: member.agentId, sessionId: member.sessionId }, locator: locator.data }, profile: member.profile };
}

/** Both Shepherd MERGEs behind this head, each written at the reviewed head. Whether they are independent is the route's to judge. */
function twoMergesAt(reviews: ReadonlyMap<string, Verdict>, head: string): TwoMerge | undefined {
  const reviewed = reviewedMergeAt(reviews, head);
  const verdict = reviewed && mergeRefAt(reviewed.source, reviewed.fromHead);
  const adversary = reviewed && adversaryMergeAt(reviewed.source.panel, reviewed.fromHead);
  const profile = reviewed?.source.reviewerProfile;
  if (!reviewed || !verdict || !adversary || profile === undefined) return undefined;
  return { correctness: { verdict, profile }, adversary, ...(reviewed.mergeUp && { mergeUp: reviewed.mergeUp }) };
}

/**
 * At a head a clean merge-up made, a `behind` read whose own required checks are green counts as green: a strict base that keeps moving
 * would otherwise hold the run forever. The merge step still gates on the base. So does a `baseMoved` read: a non-strict base that moved
 * past the head's green, which land merges as it stands, so it is never updated and would hold the run forever too (TP-3933). Any other
 * head waits for its update and a green read.
 */
const greenAt = (ci: CiSnapshot, mergeUp: MergeUp | undefined): boolean =>
  ci.verdict === "green" || (ci.verdict === "behind" && ci.checksGreen === true && (mergeUp !== undefined || ci.baseMoved === true));

/** What the release step is asked at a head: the verdict refs it judges, and the key that marks them used once they released. */
interface Ask {
  key: string;
  refs: Record<string, unknown> & { mergeUp?: MergeUp };
}

function askFor(holdClass: string | undefined, reviews: ReadonlyMap<string, Verdict>, head: string): Ask | undefined {
  if (holdClass === G10_REVIEW_CLASS) {
    const judged = judgedAt(reviews, head);
    return judged && { key: JSON.stringify([head, judged.verdict.locator]), refs: { ...judged } };
  }
  if (holdClass !== G10_ADVERSARY_CLASS) return undefined;
  const merges = twoMergesAt(reviews, head);
  return merges && { key: JSON.stringify([head, merges.correctness.verdict.locator, merges.adversary.verdict.locator]), refs: { rule: TWO_MERGE_RULE, ...merges } };
}

/**
 * The two-MERGE ask is newer than the adversary member, so an older build recorded panels that now qualify and went on
 * without the step. Such a record replays as it ran; at the frontier the ask is made live.
 */
function recordedWithoutAsk(ctx: WorkflowContext, holdClass: string | undefined): boolean {
  if (holdClass !== G10_ADVERSARY_CLASS) return false;
  const next = ctx.historyNext();
  return next !== undefined && !stepIdMatches(G10_RELEASE_STEP, next);
}

/**
 * Runs whose newest release ask, at the head mapped to, was answered no by a replayed step: an earlier build judged it, so a deploy
 * that fixed the rule would never be asked. The merge wait at that head ends once and the run asks again under the code serving now (TP-3956).
 */
const replayedRefusals = new Map<string, string>();

/** True once when the run's newest release ask at `head` was a replayed no; the merge wait then ends with no merge, so the run asks live. */
function takeG10Recheck(runId: string, head: string): boolean {
  if (replayedRefusals.get(runId) !== head) return false;
  replayedRefusals.delete(runId);
  return true;
}

/** The merge wait's recheck for the run registered on `repo#pr`; an unregistered PR has no run to ask. */
export const g10Recheck = (store: () => { byPr: (repo: RepoSlug, pr: number) => { runId: string } | undefined }): TakeRecheck => (repo, pr, sha) => {
  const runId = store().byPr(repo, pr)?.runId;
  return runId !== undefined && takeG10Recheck(runId, sha);
};

/**
 * Records the release as a step, so `shepherd status` and the ledger show it; the route re-reads the PR head and the hold before it
 * writes. A `g10-review` hold is judged on one opus MERGE, a `g10-adversary` hold on Shepherd's correctness and adversary MERGEs.
 * A shadow would-release is asked once per pair of verdicts, as a release is.
 */
export async function releaseG10Hold(run: G10WorkflowRun, holdReason: string | null | undefined): Promise<void> {
  const ci = run.lastCi;
  const holdClass = holdClassOf(holdReason);
  const ask = ci && askFor(holdClass, run.reviews, ci.headSha);
  if (!ci || !ask || used.get(run.ctx)?.has(ask.key) || recordedWithoutAsk(run.ctx, holdClass)) return;
  const attempt = run.ctx.iteration(G10_RELEASE_STEP);
  const replayed = run.ctx.historyNext() !== undefined;
  const input = { runId: run.ctx.runId, ...run.target, head: ci.headSha, ...ask.refs, checks: { head: ci.headSha, green: greenAt(ci, ask.refs.mergeUp) } };
  const done = await step(run.ctx, `${G10_RELEASE_STEP}:${ci.headSha}:${attempt}`, input, G10ReleaseResult);
  if (done.released || done.wouldRelease) used.set(run.ctx, (used.get(run.ctx) ?? new Set()).add(ask.key));
  if (replayed && !done.released && !done.wouldRelease) replayedRefusals.set(run.ctx.runId, ci.headSha);
  else replayedRefusals.delete(run.ctx.runId);
}

/**
 * A conflict read after the review leaves the round before `onCiRead` judges the hold, so a MERGE that stands at a
 * head green at its CI read would never release it (TP-3198, cause E). A record from before this goes on without the
 * policy read, or ends paused on the gate, and replays as it ran.
 */
export async function releaseBeforeLeaving(run: G10WorkflowRun & Parameters<typeof narrowToRegistration>[0]): Promise<void> {
  const next = run.ctx.historyNext();
  const recordedWithout = next === undefined ? run.ctx.resumedGate() !== undefined : !stepIdMatches("sh-policy", next);
  if (!recordedWithout) await releaseG10Hold(run, await narrowToRegistration(run));
}
