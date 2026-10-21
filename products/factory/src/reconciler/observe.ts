import { z } from "zod";
import type { BackstopCommit, BackstopDonePr, BackstopOpenPr, BackstopSnapshot, RollupContext, RulesetList } from "@titan-design/github";
import { ciEvent, fromBackstopContext, type BackstopContext, type Transport } from "../event-log/ci-keys.js";
import type { NewEvent } from "../event-log/event-log.js";
import { fromBackstopDonePr, fromBackstopMain, fromBackstopOpenPr, fromBackstopRulesets, repoEvent } from "../event-log/repo-keys.js";
import type { RepoCursor } from "./cursor.js";
import type { Observation, Observe } from "./service.js";

const BRANCH = "main";

const SeenRulesets = z.record(z.string(), z.string());

/** TP-3097's answer for one read: only `confirmed` may become a row; `non-ancestor` is a tip off the cursor's line. */
export type GuardVerdict = { kind: "confirmed"; by?: "non-ancestor" } | { kind: "stale" | "pending" | "unknown" };

/** TP-3097's head and tip guard, injected with its verdicts already read, so observe stays pure. */
export interface HeadTipGuard {
  confirmHead(repo: string, pr: number, sha: string): GuardVerdict;
  /** `cursor` is the last scanned tip; `by: "non-ancestor"` says main no longer descends from it. */
  confirmTip(repo: string, branch: string, sha: string, cursor: string | null): GuardVerdict;
}

interface ObserveDeps {
  guard: HeadTipGuard;
  now: () => number;
}

type BackstopEvent = Observation["events"][number];
type Disagreement = Observation["disagreements"][number];

interface Part {
  events: BackstopEvent[];
  disagreements: Disagreement[];
}

/** Plan §1.3: every ingress kind plus RulesChanged, keyed by the same functions the ingress uses so the two dedupe. */
export function createObserve(deps: ObserveDeps): Observe {
  return (repo, snapshot, cursor, rulesets) => {
    const transport: Transport = { source: "backstop", observedAt: new Date(deps.now()).toISOString() };
    const main = observeMain(repo, snapshot.main, cursor.main?.value ?? null, deps.guard, transport);
    const open = snapshot.open.map((pr) => observeOpen(repo, pr, deps.guard, transport));
    const done = snapshot.done.flatMap((pr) => fromBackstopDonePr(repo, doneNode(pr)).map((o) => backstopRow(repoEvent(o, transport))));
    const ruleset = observeRulesets(repo, rulesets, cursor, transport);
    const parts = [main, ...open, { events: [...done, ...ruleset.events], disagreements: [] }];
    return {
      events: parts.flatMap((part) => part.events),
      disagreements: parts.flatMap((part) => part.disagreements),
      cursor: definedOnly({ main: main.cursor, done: newestDone(snapshot.done, cursor.done?.value), rulesets: ruleset.cursor }),
    };
  };
}

/** The service stamps source and delivery id; an observation carries neither. */
function backstopRow(event: NewEvent): BackstopEvent {
  if (event.rule === "identity") {
    const { source, deliveryId, ...rest } = event;
    void [source, deliveryId];
    return rest;
  }
  const { source, deliveryId, ...rest } = event;
  void [source, deliveryId];
  return rest;
}

function unconfirmed(verdict: GuardVerdict, subject: string, detail: string): Disagreement[] {
  if (verdict.kind === "confirmed") return [];
  return [{ class: verdict.kind === "stale" ? "stale-read" : "unconfirmed", subject, detail }];
}

/** A PR's base and reviews are read as they stand; its head, and the CI on it, only once the guard confirms the head. */
function observeOpen(repo: string, pr: BackstopOpenPr, guard: HeadTipGuard, transport: Transport): Part {
  const verdict = guard.confirmHead(repo, pr.number, pr.headRefOid);
  const headConfirmed = verdict.kind === "confirmed";
  const node = { number: pr.number, headRefOid: pr.headRefOid, baseRefName: pr.baseRefName, reviews: { nodes: pr.reviews } };
  const observed = fromBackstopOpenPr(repo, node).filter((o) => headConfirmed || o.kind !== "HeadPushed");
  const ci = headConfirmed && pr.head !== null ? ciRows(repo, pr.head, transport) : [];
  return { events: [...observed.map((o) => backstopRow(repoEvent(o, transport))), ...ci], disagreements: unconfirmed(verdict, `${repo}#${pr.number}`, pr.headRefOid) };
}

function ciRows(repo: string, commit: BackstopCommit, transport: Transport): BackstopEvent[] {
  return commit.contexts.flatMap((context) => {
    const observation = fromBackstopContext(repo, commit.oid, contextNode(context));
    return observation === undefined ? [] : [backstopRow(ciEvent(observation, transport))];
  });
}

function contextNode(context: RollupContext): BackstopContext {
  if (context.kind === "status") return { __typename: "StatusContext", context: context.context, state: context.state, createdAt: context.createdAt };
  const { databaseId, name, status, conclusion, completedAt } = context;
  return { __typename: "CheckRun", databaseId, name, status, conclusion, completedAt };
}

function doneNode(pr: BackstopDonePr) {
  const mergedBy = pr.mergedBy === null ? null : { login: pr.mergedBy };
  return { number: pr.number, merged: pr.merged, mergedBy, mergeCommit: pr.mergeCommit === null ? null : { oid: pr.mergeCommit }, closedAt: pr.closedAt };
}

/**
 * `cursor..tip` is read whole. An unconfirmed tip emits nothing and keeps the cursor; a tip that left the cursor's line
 * still moves main and says so (TP-3137 turns that into `Reverted`).
 */
function observeMain(repo: string, main: BackstopSnapshot["main"], cursor: string | null, guard: HeadTipGuard, transport: Transport): Part & { cursor: string | undefined } {
  const kept = cursor ?? undefined;
  if (main.tip === cursor) return { events: [], disagreements: [], cursor: kept };
  const verdict = guard.confirmTip(repo, BRANCH, main.tip, cursor);
  const subject = `${repo}:${BRANCH}`;
  if (verdict.kind !== "confirmed") return { events: [], disagreements: unconfirmed(verdict, subject, main.tip), cursor: kept };
  const lost = verdict.by === "non-ancestor" && cursor !== null ? [{ class: "main-ancestry-lost" as const, subject, detail: `${cursor}..${main.tip}` }] : [];
  const events = [backstopRow(repoEvent(fromBackstopMain(repo, BRANCH, main.tip), transport)), ...main.commits.flatMap((commit) => ciRows(repo, commit, transport))];
  return { events, disagreements: lost, cursor: heldCursor(main, kept) };
}

const running = (context: RollupContext): boolean => (context.kind === "check" ? context.status !== "COMPLETED" : !["SUCCESS", "FAILURE", "ERROR"].includes(context.state));

/** The reconciler reads only main, so the cursor stops below the oldest commit whose checks still run; the next read re-reads it. */
function heldCursor(main: BackstopSnapshot["main"], kept: string | undefined): string | undefined {
  const newestFirst = main.commits.map((commit) => commit.contexts.some(running));
  const oldestRunning = newestFirst.lastIndexOf(true);
  if (oldestRunning < 0) return main.tip;
  return main.commits[oldestRunning + 1]?.oid ?? kept;
}

function newestDone(done: BackstopDonePr[], kept: string | undefined): string | undefined {
  const stamps = [...done.map((pr) => pr.updatedAt), ...(kept === undefined ? [] : [kept])];
  return stamps.reduce<string | undefined>((newest, at) => (newest === undefined || Date.parse(at) > Date.parse(newest) ? at : newest), undefined);
}

/**
 * A ruleset whose `updated_at` differs from the cursor's map is a change. A deletion is absent from the list, so only the
 * webhook reports one (TP-3098 plan open question 1). An unchanged or unreadable list moves nothing.
 */
function observeRulesets(repo: string, list: RulesetList | undefined, cursor: RepoCursor, transport: Transport): { events: BackstopEvent[]; cursor: string | undefined } {
  if (list === undefined || list.notModified || list.unreadable) return { events: [], cursor: undefined };
  const seen = SeenRulesets.parse(JSON.parse(cursor.rulesets?.value ?? "{}"));
  const moved = Object.fromEntries(Object.entries(list.rulesets).filter(([id, at]) => seen[id] !== at));
  return { events: fromBackstopRulesets(repo, moved).map((o) => backstopRow(repoEvent(o, transport))), cursor: JSON.stringify(list.rulesets) };
}

function definedOnly(next: Record<"main" | "done" | "rulesets", string | undefined>): Observation["cursor"] {
  const { main, done, rulesets } = next;
  return { ...(main !== undefined && { main }), ...(done !== undefined && { done }), ...(rulesets !== undefined && { rulesets }) };
}
