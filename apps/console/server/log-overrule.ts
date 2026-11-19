/**
 * The log's Overrule tap (TP-6778): the owner takes another pick on a round question or deposit that auto-by-rec resolved.
 * The resolved answer stays where it is (feedback.json and the spool answer are written once), so the overrule is a
 * record and a notice: one `overruled` row in the by-rec log naming both picks, one owner-remote row in the decision log,
 * and one message to the asker naming the original pick and the new one, asking it to reverse. A merge has no overrule;
 * its row keeps the PR's revert link.
 *
 * `log.overrule-options` (read) lists the picks and says why the tap would be refused; `log.overrule` (owner-write) admits
 * only the owner, then claims the subject with a `wx` marker, so a second overrule of the same row is refused.
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { promptLine, type ByRecRow } from "@titan-design/owner-queue";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import { appendByRecRows, readByRecRows } from "./by-rec-log.js";
import { decisionLogResult, type DecisionAnswer, type DecisionLog } from "./decision-log.js";
import { overruleTarget, type OverruleDirs, type OverruleTarget } from "./log-overrule-target.js";
import { ownerWriteCommand, ownerWriteRefusal, readCommand, type ConsoleContext } from "./owner-guard.js";
import type { SeatNotifier } from "./round-notice-transport.js";
import { writeJsonOnce } from "./state-file.js";

const OVERRULE_ACTOR = Object.freeze({ class: "owner-remote", id: "titan-console", channel: "console:log" } as const);
const MARKERS_DIR = "auto-by-rec";
const MARKER_SCHEMA = "titan-console/auto-by-rec-overrule@1";
const MAX_PICK = 120;
const ALREADY = "this decision was already overruled";

export interface OverruleDeps extends OverruleDirs {
  stateDir: string;
  decisionLog?: DecisionLog;
  /** Absent, the overrule is recorded and no seat is told. */
  notify?: SeatNotifier;
  now?: () => number;
}

const subjectArgs = z.strictObject({ source: z.enum(["round", "deposit"]), id: z.string().min(1).max(300) });
const overruleArgs = subjectArgs.extend({ optionId: z.string().min(1).max(500) });
const overruleResult = z.object({ from: z.string(), to: z.string(), seat: z.string(), notice: z.enum(["sent", "failed", "not-wired"]), log: decisionLogResult.optional() });
const optionsResult = z.object({ options: z.array(z.object({ id: z.string(), label: z.string(), recommended: z.boolean() })), refusal: z.string().nullable() });

type Subject = z.infer<typeof subjectArgs>;
type OverruleResult = z.infer<typeof overruleResult>;

const sameSubject = ({ source, id }: Subject) => (row: ByRecRow): boolean => row.subject.source === source && row.subject.id === id;

interface Overrulable {
  resolved: ByRecRow;
  overruled: boolean;
}

/** Only a live `resolved` row was applied; a shadow row or a failed one has nothing to overrule. */
async function findRows(stateDir: string, subject: Subject): Promise<Overrulable> {
  const rows = (await readByRecRows(stateDir)).filter(sameSubject(subject));
  const resolved = rows.find((row) => row.mode === "live" && row.result === "resolved");
  if (resolved === undefined) throw failure(`no live auto-by-rec answer for ${subject.source} ${subject.id}`, EXIT.NOINPUT);
  return { resolved, overruled: rows.some((row) => row.result === "overruled") };
}

const labelOf = (target: OverruleTarget, id: string): string => target.options.find((option) => option.id === id)?.label ?? id;
const pickText = (text: string): string => promptLine(text).slice(0, MAX_PICK);

const overruleNotice = (subject: Subject, from: string, to: string): string =>
  `titan-console: the owner overruled the auto-by-rec answer to ${subject.source} ${subject.id}. ` +
  `Auto-by-rec picked "${pickText(from)}"; the owner picks "${pickText(to)}". ` +
  `Reverse what you did on the first pick where you can, and act on the owner's. The overrule is recorded in the console's auto-by-rec log.`;

function overruleRow(resolved: ByRecRow, optionId: string, at: string): ByRecRow {
  const { schema, subject, recommendation, openedAt, facts, resolver } = resolved;
  return { schema, subject, recommendation, openedAt, resolvedAt: at, facts, mode: "live", result: "overruled", resolver, overrule: { answer: optionId, by: { ...OVERRULE_ACTOR } } };
}

async function claim(stateDir: string, subject: Subject, at: string): Promise<boolean> {
  const dir = path.join(stateDir, MARKERS_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const name = `overrule-${createHash("sha256").update(`${subject.source}:${subject.id}`).digest("hex").slice(0, 32)}.json`;
  return writeJsonOnce(path.join(dir, name), { schema: MARKER_SCHEMA, subject, at, by: OVERRULE_ACTOR });
}

async function tell(notify: SeatNotifier | undefined, seat: string, text: string): Promise<OverruleResult["notice"]> {
  if (notify === undefined) return "not-wired";
  return notify(seat, text).then(
    () => "sent" as const,
    () => "failed" as const,
  );
}

function checkPick(target: OverruleTarget, resolved: ByRecRow, optionId: string): void {
  if (!target.options.some((option) => option.id === optionId)) throw failure("that pick is not one of the item's options", EXIT.DATAERR);
  if (optionId === resolved.recommendation.answer) throw failure("that is the pick auto-by-rec already took", EXIT.DATAERR);
}

export async function overrule(deps: OverruleDeps, { optionId, ...subject }: z.infer<typeof overruleArgs>): Promise<OverruleResult> {
  const { resolved, overruled } = await findRows(deps.stateDir, subject);
  if (overruled) throw failure(ALREADY, EXIT.DATAERR);
  const target = await overruleTarget(subject.source, resolved, deps);
  checkPick(target, resolved, optionId);
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  if (!(await claim(deps.stateDir, subject, at))) throw failure(ALREADY, EXIT.DATAERR);
  await appendByRecRows(deps.stateDir, [overruleRow(resolved, optionId, at)]);
  const answer: DecisionAnswer = { optionId, by: { ...OVERRULE_ACTOR }, at };
  const log = await deps.decisionLog?.record(target.item, answer);
  const [from, to] = [labelOf(target, resolved.recommendation.answer), labelOf(target, optionId)];
  const notice = await tell(deps.notify, target.seat, overruleNotice(subject, from, to));
  return { from, to, seat: target.seat, notice, ...(log && { log }) };
}

async function overruleOptions(deps: OverruleDeps, subject: Subject, ctx: ConsoleContext): Promise<z.infer<typeof optionsResult>> {
  const { resolved, overruled } = await findRows(deps.stateDir, subject);
  const target = await overruleTarget(subject.source, resolved, deps);
  const options = target.options.map(({ id, label }) => ({ id, label, recommended: id === resolved.recommendation.answer }));
  return { options, refusal: overruled ? ALREADY : ownerWriteRefusal(ctx) };
}

export function logOverruleCommands(deps: OverruleDeps) {
  return {
    "log.overrule-options": readCommand({
      name: "log.overrule-options",
      description: "The picks an auto-by-rec round or deposit answer offered, the one it took marked, and why an overrule would be refused (null when it would run)",
      args: subjectArgs,
      result: optionsResult,
      run: (args, ctx: ConsoleContext) => overruleOptions(deps, args, ctx),
    }),
    "log.overrule": ownerWriteCommand({
      name: "log.overrule",
      description: "Overrule an auto-by-rec round or deposit answer with another pick: logs an overruled row and an owner answer, and tells the asker to reverse; once per decision",
      args: overruleArgs,
      result: overruleResult,
      ownerWrite: true,
      run: (args) => overrule(deps, args),
    }),
  };
}
