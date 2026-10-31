import type { RepoSlug } from "@titan-design/github";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { repairStopTable, type RepairStopTable } from "./repair-stop.js";
import { proofWaiverTable, type ProofWaivers } from "./proof-waiver.js";
import { claimPlanApprovals, planApprovalTable, repointPlanApprovals, type PlanApprovals } from "./plan-approval.js";
import { mergeBaseExceptionTable, repointMergeBaseException, type MergeBaseExceptions } from "./merge-base-exception.js";
import { watchListTable, type WatchList } from "./watch-list.js";
import { gateEvidenceTable, holdPassedAt, type GateEvidence } from "./lan-gates.js";
import { registrationOf } from "./registration-of.js";
import { appendEvent, eventsFor, latestChangeId, type EventContext, type EventKind, type ShepherdEvent } from "./events.js";
import { moveAccountHold } from "./account-store.js";
import { parkSettled, repointParkSettled, settlePark, type ParkSettle } from "./park-settled.js";
import { HoldSatisfiedBySchema, type HoldSatisfaction, type HoldSatisfiedBy } from "./hold-satisfaction.js";
import { readSlots, reclassHold, recordVouch, repointRunRows, vouchedLine, writeSlotRow, type Reclass, type Vouch } from "./hold-slot-rows.js";
import { afterHold, isAdversaryHold, liftClass, liftTop, type HoldSlots, type Lift, type SlotHold } from "./hold-slots.js";
import { isOwnerHold, liftOwnerHold, placeOwnerHold, recordOwnerAsked, type OwnerHold } from "./owner-hold-rows.js";
import { writeRegistrant, writeRegistrationFacts, type RegistrationFacts, type RegistrationFactsInput } from "./registration-facts.js";
import { RegistrationRefused, repeatedPolicy, type EffectivePolicy } from "./policy.js";
import { TASK_KINDS, kindMoveRefusal, type TaskKind } from "./task-kind.js";
import type { KindMove } from "./register-kind.js";

export { TASK_KINDS, kindMoveRefusal, type TaskKind } from "./task-kind.js";

/** A PR, or a branch whose PR does not exist yet, handed to one shepherd-pr run. */
export interface RegistrationInput extends RegistrationFactsInput {
  repo: RepoSlug;
  pr?: number;
  branch?: string;
  runId: string;
  task: string;
  implementer: string;
  reviewer?: string;
  policy: EffectivePolicy;
  /** Absent means `unknown`; a value outside `TASK_KINDS` is refused. `unknown` never carries a reviewed MERGE. */
  kind?: string;
  /** Names the slice of a multi-slice task this PR delivers; landing then notes the task instead of closing it. */
  slice?: string;
  /** The agent-chat session that registered the run; only the first one is kept. */
  registrant?: string;
}

export type RegistrationUpdate = Pick<RegistrationInput, "task" | "implementer" | "reviewer" | "policy" | "kind" | "slice" | "headSha" | "base" | "lastSlice" | "registrant"> & Partial<KindMove>;

export interface Registration extends RegistrationFacts {
  repo: RepoSlug;
  pr: number | null;
  branch: string | null;
  runId: string;
  task: string;
  implementer: string;
  reviewer: string | null;
  policy: EffectivePolicy;
  kind: TaskKind;
  slice: string | null;
  /** The session that first registered the run, and whether it was the implementer then; null or absent when none was recorded. */
  registrant?: { name: string; fixer: boolean } | null;
  held: boolean;
  holdReason: string | null;
  /** The reviewer a hold waits on, set only by `hold --reviewer`; never read out of the reason. */
  holdReviewer: string | null;
  /** The head at which the hold's reviewer sent MERGE, and who sent it; a merge at that head passes the hold. */
  holdSatisfied: HoldSatisfaction | null;
  /** A Version Packages PR's head that passed the release preflight under an auto policy, and when; other merges in the repo wait on it. */
  releaseReady: { head: string; at: string } | null;
  /** The head `shepherd review` asked Shepherd's own reviewer to review; `takenAt` is null until a run's review intent took it. */
  reviewRequest: { head: string; at: string; takenAt: string | null } | null;
  /** Apart from the gating hold, and lifted only by `releaseOwnerHold`; while set, `held` is true and, with no other hold, `holdReason` is its reason. */
  ownerHold: OwnerHold | null;
  createdAt: string;
  updatedAt: string;
}

export { HoldSatisfiedBySchema, type HoldSatisfaction, type HoldSatisfiedBy } from "./hold-satisfaction.js";

/** What the merge guard asks: the reason `repo#pr`, or the PR's head `branch`, is held, or undefined when nothing holds it; a hold satisfied at `sha` does not hold a merge there. */
export interface HoldLookup {
  heldReason(repo: RepoSlug, pr: number, branch?: string, sha?: string): string | undefined;
}

export { holdReviewerMigration, holdSatisfiedMigration, holdSlotsMigration, lastSliceMigration, lineageMigration, ownerHoldMigration, parkSettledMigration, registrantMigration, registrationFactsMigration, repairStopMigration, reviewRequestMigration, shepherdMigration, sliceMigration } from "./store-migrations.js";

import type { Author, AuthorInput, AuthorRow } from "./author-types.js";
export type { Author, AuthorInput } from "./author-types.js";

import type { RegistrationRow as Row } from "./registration-row.js";

const KindSchema = z.enum(TASK_KINDS);

/** GitHub treats repo names case-insensitively, so a hold on one spelling must hold every spelling. */
const repoKey = (repo: RepoSlug): string => repo.toLowerCase();

const REFS_HEADS = "refs/heads/";

/** A branch spelled `refs/heads/<b>` and one spelled `<b>` are the same branch; strip one leading prefix. */
const branchName = (branch: string): string => (branch.startsWith(REFS_HEADS) ? branch.slice(REFS_HEADS.length) : branch);

/** Hears a registration after a write to it commits, `hold-eased` when a lift or reclass may end an owner hold that keeps a gate; it must not throw, since the write has already landed. */
type RegistrationListener = (registration: Registration, change?: "hold-eased") => void;

/** Shepherd registrations in the factory database; the table comes from `shepherdMigration`. */
export class ShepherdStore implements HoldLookup {
  constructor(private readonly db: Db, private readonly now: () => number = Date.now, private readonly onChange: RegistrationListener = () => undefined) {}

  register(input: RegistrationInput): Registration {
    if (input.pr === undefined && input.branch === undefined) throw new Error("a shepherd registration needs a pr or a branch");
    const kind = KindSchema.parse(input.kind ?? "unknown");
    const at = this.stamp();
    this.db.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO shepherd_registration (repo, pr, branch, run_id, task, implementer, reviewer, policy, kind, slice, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      insert.run(repoKey(input.repo), input.pr ?? null, input.branch === undefined ? null : branchName(input.branch), input.runId, input.task, input.implementer, input.reviewer ?? null, JSON.stringify(input.policy), kind, input.slice ?? null, at, at);
      writeRegistrationFacts(this.db, input.runId, input);
      writeRegistrant(this.db, input.runId, input.registrant, input.implementer);
      claimPlanApprovals(this.db, input.runId, input.task, input.repo);
    })();
    return this.changed(input.runId, this.byRun(input.runId)!);
  }

  byRun(runId: string): Registration | undefined {
    return this.one("run_id = ?", runId);
  }

  byPr(repo: RepoSlug, pr: number): Registration | undefined {
    return this.one("repo = ? AND pr = ?", repoKey(repo), pr);
  }

  byBranch(repo: RepoSlug, branch: string): Registration | undefined {
    const name = branchName(branch);
    return this.one("repo = ? AND (branch = ? OR branch = ?)", repoKey(repo), name, `${REFS_HEADS}${name}`);
  }

  /** Every registration, oldest first. */
  all(): Registration[] {
    const rows = this.db.prepare<[], Row>("SELECT * FROM shepherd_registration ORDER BY created_at, rowid").all();
    return rows.map(registrationOf);
  }

  /**
   * A repeat registration refreshes who and what the run is for; its merge mode and fixer only narrow the stored policy.
   * An omitted kind keeps the stored one, so a repeat without `--kind` cannot change whether the run carries a reviewed MERGE.
   * An explicit kind that would move a correctness run outside the fix-proof kinds, or a security run to any other kind, is refused (`kindMoveRefusal`);
   * a move into test-only also needs `diff`, the PR's test-only classification. `guard` replaces `kindMoveRefusal`.
   */
  update(runId: string, meta: RegistrationUpdate): Registration {
    const explicitKind = meta.kind === undefined ? undefined : KindSchema.parse(meta.kind);
    const write = this.db.transaction(() => {
      const stored = this.byRun(runId);
      if (!stored) throw new Error(`shepherd-pr run ${runId} has no registration`);
      const policy = repeatedPolicy(meta.policy, stored.policy);
      const kind = explicitKind ?? stored.kind;
      const refusal = (meta.guard ?? kindMoveRefusal)(stored.kind, kind, meta.diff);
      if (refusal) throw new RegistrationRefused(`run ${runId}: ${refusal}`);
      this.db
        .prepare("UPDATE shepherd_registration SET task = ?, implementer = ?, reviewer = ?, policy = ?, kind = ?, slice = ?, updated_at = ? WHERE run_id = ?")
        .run(meta.task, meta.implementer, meta.reviewer ?? null, JSON.stringify(policy), kind, meta.slice ?? null, this.stamp(), runId);
      writeRegistrationFacts(this.db, runId, meta);
      writeRegistrant(this.db, runId, meta.registrant, meta.implementer);
    });
    write.immediate();
    return this.changed(runId, this.byRun(runId)!);
  }

  /** Record the PR a branch registration was waiting for; throws when the run has no registration. */
  setPr(runId: string, pr: number): Registration {
    const changed = this.db.prepare("UPDATE shepherd_registration SET pr = ?, updated_at = ? WHERE run_id = ?").run(pr, this.stamp(), runId).changes;
    if (changed === 0) throw new Error(`shepherd-pr run ${runId} has no registration`);
    return this.changed(runId, this.byRun(runId)!);
  }

  /** Points a registration, and the authors, hold events, proofs, settled parks, merge-base exception and own account hold recorded for its run, at the run that replaces its failed one; the old run stays in the workflow database. */
  repoint(runId: string, newRunId: string): Registration {
    const move = this.db.transaction(() => {
      const changed = this.db.prepare("UPDATE shepherd_registration SET run_id = ?, updated_at = ? WHERE run_id = ?").run(newRunId, this.stamp(), runId).changes;
      if (changed === 0) throw new Error(`shepherd-pr run ${runId} has no registration`);
      this.db.prepare("UPDATE shepherd_lineage SET run_id = ? WHERE run_id = ?").run(newRunId, runId);
      repointParkSettled(this.db, runId, newRunId);
      repointRunRows(this.db, runId, newRunId);
      repointMergeBaseException(this.db, runId, newRunId);
      repointPlanApprovals(this.db, runId, newRunId);
      moveAccountHold(this.db, runId, newRunId);
    });
    move();
    return this.changed(newRunId, this.byRun(newRunId)!);
  }

  /** A hold or release clears any satisfaction, so a re-hold waits for its reviewer again; another class waits under a `g10-adversary` hold (`afterHold`); an owner-asked hold takes its own slot. */
  hold(runId: string, reason: string, reviewer?: string, by: EventContext = {}): Registration {
    this.db.transaction(() => this.placeHold(runId, { reason, reviewer: reviewer ?? null }, by))();
    return this.changed(runId, this.byRun(runId)!);
  }

  /** Lifts the hold that gates, and records its reason, or `reason` when given; a hold parked under it gates in its place. `reason` goes to the event only, never to the row. */
  release(runId: string, by: EventContext = {}, reason?: string): Registration {
    this.lift(runId, (slots) => ({ ...liftTop(slots), ...(reason !== undefined && { reason }) }), by);
    return this.byRun(runId)!;
  }

  /** Compare-and-swap: releases only while the run's gating hold is exactly `reason`; false when a release or another hold got there first. */
  releaseIfHeld(runId: string, reason: string, by: EventContext = {}): boolean {
    return this.lift(runId, (slots) => (slots.top?.reason === reason ? liftTop(slots) : undefined), by);
  }

  /** Compare-and-swap in one transaction: `reclassHold` swaps the gating hold, only while it is `from`, for `next` of the hold left gating. */
  reclassIfHeld(runId: string, from: string, next: Reclass["next"], by: EventContext = {}): string | null | false {
    return this.changed(runId, this.db.transaction(() => reclassHold(this.db, runId, { from, next }, this.stamp(), by))(), "hold-eased");
  }

  /** Compare-and-swap: lifts the owner-asked hold only while one is set, recording its reason, or `reason` when given; false, writing nothing, when none is. */
  releaseOwnerHold(runId: string, by: EventContext = {}, reason?: string): boolean {
    return this.changed(runId, this.db.transaction(() => liftOwnerHold(this.db, runId, this.stamp(), by, reason))(), "hold-eased");
  }

  /** Records that the owner was asked about the run's owner-asked hold again; false when it has none. */
  markOwnerAsked(runId: string): boolean {
    return this.changed(runId, recordOwnerAsked(this.db, runId, this.stamp()));
  }

  /** Compare-and-swap: lifts only the hold `liftClass` picks for `holdClass`; false, writing nothing, when it picks none. */
  releaseClass(runId: string, holdClass: string | undefined, by: EventContext = {}): boolean {
    return this.lift(runId, (slots) => liftClass(slots, holdClass), by);
  }

  /** The id of the run's latest hold or release event, 0 when it has none; a reader keeps it to learn, at its write, whether any change landed since. */
  changeMark(runId: string): number {
    return latestChangeId(this.db, runId);
  }

  /** Compare-and-swap: holds only while no hold or release has landed since `mark` was read, so a hold or release made meanwhile stands untouched; false when one did. */
  holdIfUnchanged(runId: string, mark: number, reason: string, by: EventContext = {}): boolean {
    return this.changed(runId, this.db.transaction(() => latestChangeId(this.db, runId) === mark && (this.placeHold(runId, { reason, reviewer: null }, by), true))());
  }

  /** Holds unless a `g10-adversary` hold already gates, so that hold keeps its reason and reviewer; false, writing nothing, when one does. */
  holdUnlessAdversary(runId: string, reason: string, by: EventContext = {}): boolean {
    return this.changed(runId, this.db.transaction(() => !isAdversaryHold(readSlots(this.db, runId).top?.reason) && (this.placeHold(runId, { reason, reviewer: null }, by), true))());
  }

  /** The hold of another class kept under a gating `g10-adversary` hold, or null when there is none. */
  readonly parkedHold = (runId: string): SlotHold | null => readSlots(this.db, runId).parked;

  /** Records a probe's proof that a head is a clean merge-up; a repeat changes nothing. */
  vouch(runId: string, proof: Vouch): void {
    recordVouch(this.db, runId, proof, this.stamp());
  }

  /** `fromHead` and every head recorded as a clean merge-up of it onto `baseRef` for the run. */
  vouchedLine(runId: string, fromHead: string, baseRef: string): Set<string> {
    return vouchedLine(this.db, runId, fromHead, baseRef);
  }

  /** The seat's stops on fixer dispatch; apart from holds, so a stop never gates or releases a merge. */
  readonly repairStops = (): RepairStopTable => repairStopTable(this.db, () => this.stamp());

  /** The owner's fix-proof waivers, which only the `waive-proof` answer to `sh-sent-back` writes. */
  readonly proofWaivers = (): ProofWaivers => proofWaiverTable(this.db, () => this.stamp());

  /** The owner's plan-time answers, which only the console's plan-approval action writes; a registration claims its task's unclaimed ones. */
  readonly planApprovals = (): PlanApprovals => planApprovalTable(this.db, () => this.stamp());

  /** Planners' leave for a run's fix rounds to merge the base branch; read where a fix round's brief is built. */
  readonly mergeBaseExceptions = (): MergeBaseExceptions => mergeBaseExceptionTable(this.db, () => this.stamp());

  /** The seats' watches on PRs, read by the seat digest; a watch gates nothing. */
  readonly watches = (): WatchList => watchListTable(this.db, () => this.stamp());

  /** What gates outside GitHub Actions concluded at each head; a `lan-gates` hold stands aside at a head where they are green (`lan-gates.ts`). */
  readonly gateEvidence = (): GateEvidence => gateEvidenceTable(this.db, () => this.stamp());

  /** The run's hold, release, repair-stop and gate-cancel events and its repo's freeze, thaw and path repair-stop events, oldest first. */
  eventsOf(runId: string): ShepherdEvent[] {
    const registration = this.byRun(runId);
    return registration ? eventsFor(this.db, runId, registration.repo) : [];
  }

  /** Records a sweep's cancel of the run's gate; the caller writes it only after the cancel took. */
  recordGateCancel(runId: string, reason: string, at: string): void {
    if (this.byRun(runId)) this.record(runId, "gate-cancel", reason, at, {});
  }

  private record(runId: string, kind: EventKind, reason: string | null, at: string, by: EventContext): void {
    const registration = this.byRun(runId)!;
    appendEvent(this.db, { runId, repo: registration.repo, pr: registration.pr, kind, reason, at, actor: by.actor, headSha: by.headSha });
  }

  /** Compare-and-swap: records the MERGE only while the run is still held for `reviewer`; false when a release or re-hold got there first. */
  satisfyHold(runId: string, reviewer: string, head: string, by: Omit<HoldSatisfiedBy, "reviewer">): boolean {
    const satisfy = "UPDATE shepherd_registration SET hold_satisfied_head = ?, hold_satisfied_by = ?, updated_at = ? WHERE run_id = ? AND held = 1 AND hold_reviewer = ?";
    return this.changed(runId, this.db.prepare(satisfy).run(head, JSON.stringify(HoldSatisfiedBySchema.parse({ ...by, reviewer })), this.stamp(), runId, reviewer).changes === 1);
  }

  /** Withdraws the satisfaction, as when the reviewer's newest verdict is FIX_FIRST; at whatever head it was read, so no later carry can restore it. */
  unsatisfyHold(runId: string): void {
    this.changed(runId, this.db.prepare("UPDATE shepherd_registration SET hold_satisfied_head = NULL, hold_satisfied_by = NULL, updated_at = ? WHERE run_id = ?").run(this.stamp(), runId).changes === 1);
  }

  /** Asks for Shepherd's own review at `head`; false when an ask at that head already stands, taken or not, so a repeat asks nothing. */
  requestReview(runId: string, head: string): boolean {
    const ask = "UPDATE shepherd_registration SET review_request_head = ?, review_request_at = ?, review_request_taken_at = NULL, updated_at = ? WHERE run_id = ? AND review_request_head IS NOT ?";
    return this.changed(runId, this.db.prepare(ask).run(head, this.stamp(), this.stamp(), runId, head).changes === 1);
  }

  /** Compare-and-swap: marks the ask at `head` taken; false when there is no untaken ask at that head. */
  takeReviewRequest(runId: string, head: string): boolean {
    const take = "UPDATE shepherd_registration SET review_request_taken_at = ?, updated_at = ? WHERE run_id = ? AND review_request_head = ? AND review_request_taken_at IS NULL";
    return this.changed(runId, this.db.prepare(take).run(this.stamp(), this.stamp(), runId, head).changes === 1);
  }

  /** Marks `head` as ready to land, or clears the mark with null. */
  setReleaseReady(runId: string, head: string | null): void {
    const changed = this.db
      .prepare("UPDATE shepherd_registration SET release_ready_head = ?, release_ready_at = ?, updated_at = ? WHERE run_id = ?")
      .run(head, head === null ? null : this.stamp(), this.stamp(), runId).changes;
    if (changed === 0) throw new Error(`shepherd-pr run ${runId} has no registration`);
    this.changed(runId, true);
  }

  /** Gives up a finished run's claim on its branch, so a later PR from the same branch can register. */
  releaseBranch(runId: string): void {
    this.changed(runId, this.db.prepare("UPDATE shepherd_registration SET branch = NULL, updated_at = ? WHERE run_id = ? AND pr IS NOT NULL").run(this.stamp(), runId).changes === 1);
  }

  /** A branch registration waiting for its PR holds that PR too. A MERGE, or green lan-gates, at `sha` passes the hold there only; none passes an owner hold. */
  heldReason(repo: RepoSlug, pr: number, branch?: string, sha?: string): string | undefined {
    const candidates = [this.byPr(repo, pr), branch === undefined ? undefined : this.byBranch(repo, branch)];
    const owner = candidates.find((registration) => registration?.ownerHold)?.ownerHold;
    const held = candidates.find((r) => r?.held && !(sha !== undefined && holdPassedAt(this, r, sha)));
    return owner?.reason ?? (held && (held.holdReason ?? "held"));
  }

  /** Records an author of the run's code; a repeat for the same agent keeps the first row, so lineage never rewrites itself. */
  recordAuthor(runId: string, agent: AuthorInput): void {
    this.db
      .prepare("INSERT INTO shepherd_lineage (run_id, agent_id, name, role, predecessor, at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (run_id, agent_id) DO NOTHING")
      .run(runId, agent.agentId, agent.name, agent.role, agent.predecessor ?? null, this.stamp());
  }

  /** Records that the exit retry of a refused park settled; a repeat keeps the first row. */
  settlePark(runId: string, headSha: string, agent: string, outcome: ParkSettle): void {
    settlePark(this.db, { runId, headSha, agent }, outcome, this.stamp());
  }

  parkSettled(runId: string, headSha: string, agent: string): boolean {
    return parkSettled(this.db, { runId, headSha, agent });
  }

  /** Every author recorded for the run, earliest first, ties broken by agent id. */
  authorsOf(runId: string): Author[] {
    const rows = this.db.prepare<[string], AuthorRow>("SELECT * FROM shepherd_lineage WHERE run_id = ? ORDER BY at, agent_id").all(runId);
    return rows.map((row) => ({ runId: row.run_id, agentId: row.agent_id, name: row.name, role: row.role, predecessor: row.predecessor, at: row.at }));
  }

  private placeHold(runId: string, hold: SlotHold, by: EventContext): void {
    if (isOwnerHold(hold.reason)) return placeOwnerHold(this.db, runId, hold, this.stamp(), by);
    this.writeSlots(runId, afterHold(readSlots(this.db, runId), hold), { kind: "hold", reason: hold.reason }, by);
  }

  private lift(runId: string, pick: (slots: HoldSlots) => Lift | undefined, by: EventContext): boolean {
    return this.changed(runId, this.db.transaction(() => {
      const next = pick(readSlots(this.db, runId));
      if (next) this.writeSlots(runId, next.slots, { kind: "release", reason: next.reason }, by);
      return next !== undefined;
    })(), "hold-eased");
  }

  /** Called once the write has committed; `false` means it wrote nothing. */
  private changed<T>(runId: string, result: T, change?: "hold-eased"): T {
    const registration = result === false ? undefined : this.byRun(runId);
    if (registration) this.onChange(registration, change);
    return result;
  }

  private writeSlots(runId: string, slots: HoldSlots, change: { kind: EventKind; reason: string | null }, by: EventContext): void {
    const at = this.stamp();
    if (writeSlotRow(this.db, runId, slots, at) === 0) throw new Error(`shepherd-pr run ${runId} has no registration`);
    this.record(runId, change.kind, change.reason, at, by);
  }

  private one(where: string, ...args: unknown[]): Registration | undefined {
    const row = this.db.prepare<unknown[], Row>(`SELECT * FROM shepherd_registration WHERE ${where}`).get(...args);
    return row && registrationOf(row);
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }
}

/** A store bound to whichever factory database the host opened; reading it unbound throws, so a merge guard fails closed. */
export interface ShepherdStoreRef {
  get(): ShepherdStore;
  /** Returns the unbind, which the host calls before it closes the database. */
  bind(db: Db): () => void;
  /** Hears every registration write on whichever store is bound, now or later; returns the unsubscribe. Optional so hand-rolled refs need not carry it. */
  onChange?(listener: RegistrationListener): () => void;
}

export function shepherdStoreRef(now: () => number = Date.now): ShepherdStoreRef {
  let store: ShepherdStore | undefined;
  const listeners = new Set<RegistrationListener>();
  return {
    get() {
      if (!store) throw new Error("the shepherd store is not bound to an open factory database");
      return store;
    },
    bind(db) {
      if (store) throw new Error("the shepherd store is already bound to an open factory database");
      const bound = new ShepherdStore(db, now, (registration, change) => listeners.forEach((listener) => listener(registration, change)));
      store = bound;
      return () => void (store === bound && (store = undefined));
    },
    onChange: (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
  };
}
