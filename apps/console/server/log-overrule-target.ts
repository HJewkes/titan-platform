/**
 * What an overrule of an auto-by-rec row acts on (TP-6778): the decision log's item for the round question or deposit the
 * row resolved, the picks the owner may take instead, and the seat to tell. Read from the files the console owns, never
 * from the request: a round from its `round.json` and `asker.json`, a deposit from the inbox spool.
 */
import path from "node:path";
import type { ByRecRow } from "@titan-design/owner-queue";
import { readSpool } from "@titan-design/owner-queue/spool";
import { EXIT } from "@titan-design/registry";
import { failure } from "./active-work.js";
import type { DecisionItem } from "./decision-log.js";
import { readAsker } from "./round-asker.js";
import { roundDecisionItem } from "./round-decisions.js";
import { SEAT_NAME } from "./round-notice-transport.js";
import { UNCLAIMED_SEAT } from "./round-subscriptions.js";
import { readManifest, roundDirExists } from "./rounds.js";

export type OverruleSource = Extract<ByRecRow["subject"]["source"], "round" | "deposit">;

export interface OverruleTarget {
  item: DecisionItem;
  /** Every pick the item offers; the recommendation by-rec took is one of them. */
  options: { id: string; label: string }[];
  /** The asker's seat, or tp-operator when the item names none. */
  seat: string;
}

export interface OverruleDirs {
  inboxDir: string;
  roundsDir: string;
}

const gone = (what: string): never => {
  throw failure(`${what} is no longer readable, so it cannot be overruled`, EXIT.NOINPUT);
};

const seatOr = (seat: string | undefined): string => (seat !== undefined && SEAT_NAME.test(seat) ? seat : UNCLAIMED_SEAT);

function factText(row: ByRecRow, key: string): string | undefined {
  const value = row.facts[key];
  return typeof value === "string" ? value : undefined;
}

async function roundTarget(row: ByRecRow, roundsDir: string): Promise<OverruleTarget> {
  const roundId = factText(row, "roundId");
  const questionId = factText(row, "questionId");
  if (roundId === undefined || questionId === undefined || !(await roundDirExists(roundsDir, roundId))) return gone("The round");
  const roundDir = path.join(roundsDir, roundId);
  const { parsed } = await readManifest(roundDir);
  const question = parsed.ok ? parsed.manifest.questions.find((each) => each.id === questionId) : undefined;
  if (question === undefined) return gone("The round question");
  const item = roundDecisionItem(question, { roundId, openedAt: row.openedAt });
  return { item, options: item.options ?? [], seat: seatOr((await readAsker(roundDir))?.seat) };
}

async function depositTarget(row: ByRecRow, inboxDir: string): Promise<OverruleTarget> {
  const item = (await readSpool(inboxDir)).items.find((each) => each.id === row.subject.id);
  if (item === undefined) return gone("The deposit");
  return { item, options: (item.options ?? []).map(({ id, label }) => ({ id, label })), seat: seatOr(item.asker) };
}

export function overruleTarget(source: OverruleSource, row: ByRecRow, dirs: OverruleDirs): Promise<OverruleTarget> {
  return source === "round" ? roundTarget(row, dirs.roundsDir) : depositTarget(row, dirs.inboxDir);
}
