import { z } from "zod";
import { OPS } from "./ops.js";
import { lintSlices, sliceWarnings } from "./slice-lint.js";

/**
 * Parses what a tick-spawned agent leaves behind: the first line of its final message (`Status:` for workers,
 * `Verdict:` for reviewers), a closing `PARKED <msgId>` line, a `Proposed tasks:` block, and a planner's
 * `burndown-slices` block. Anything the parser cannot read is `unknown`, never a guess at success.
 */

const STATUSES = ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"] as const;
type Status = (typeof STATUSES)[number];
type Verdict = "APPROVE" | "CHANGES";

interface Report {
  status: Status | "unknown";
  verdict?: Verdict;
  /** The message id of the `chat_ask` a parked worker filed. */
  parked?: string;
  pr?: string;
  /** A planner's plan file, from its `Plan: <absolute path>` line. */
  plan?: string;
  /** The items of a `Proposed tasks:` block, absent when the report has none. */
  proposed?: ProposedItem[];
  /** Why the report is refused (decision 331): the first proposed item with no valid destination. */
  refused?: string;
  firstLine: string;
  text: string;
}

const isStatus = (value: string | undefined): value is Status => (STATUSES as readonly (string | undefined)[]).includes(value);

const unmarked = (line: string): string => line.replace(/[*`]/g, "").trim();

export function parseReport(text: string): Report {
  const lines = text
    .split("\n")
    .map(unmarked)
    .filter((line) => line.length > 0);
  const firstLine = lines[0] ?? "";
  const report: Report = { status: "unknown", firstLine, text };
  const status = /^Status:\s*([A-Z_]+)\s*$/.exec(firstLine)?.[1];
  if (isStatus(status)) report.status = status;
  const verdict = /^Verdict:\s*(APPROVE|CHANGES)\s*$/.exec(firstLine)?.[1];
  if (verdict === "APPROVE" || verdict === "CHANGES") report.verdict = verdict;
  const parked = /^PARKED\s+(\S+)$/.exec(lines.at(-1) ?? "")?.[1];
  if (parked !== undefined) report.parked = parked;
  const pr = field(lines, "PR");
  if (pr !== undefined) report.pr = pr;
  const plan = field(lines, "Plan");
  if (plan !== undefined) report.plan = plan;
  const proposed = proposedItems(text);
  if (proposed !== undefined) {
    report.proposed = proposed;
    const refused = proposed.map(destinationProblem).find((problem) => problem !== undefined);
    if (refused !== undefined) report.refused = refused;
  }
  return report;
}

const field = (lines: string[], label: string): string | undefined =>
  lines.map((line) => new RegExp(`^${label}:\\s*(\\S.*?)\\s*$`).exec(line)?.[1]).find((value) => value !== undefined);

/** The reasons a proposed task may be dropped without filing it (decision 331). */
export const DROP_REASONS = ["duplicate", "already-done", "out-of-scope", "superseded"] as const;

type Destination = { kind: "filed"; id: string } | { kind: "pending"; reason: string } | { kind: "dropped"; reason: string };

interface ProposedItem {
  text: string;
  /** Absent when the item has no `->` or an arrow to something that is not filed, pending or dropped. */
  destination?: Destination;
}

const PROPOSED_HEADER = /^Proposed tasks:$/i;
const BULLET = /^[-*+]\s+(.*)$/;

/** Bullets under a `Proposed tasks:` line, up to the first line that is not one; undefined with no such line. */
function proposedItems(text: string): ProposedItem[] | undefined {
  const lines = text.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => PROPOSED_HEADER.test(unmarked(line)));
  if (start === -1) return undefined;
  const items: ProposedItem[] = [];
  for (const line of lines.slice(start + 1)) {
    const bullet = BULLET.exec(line)?.[1];
    if (bullet === undefined) break;
    items.push(proposedItem(unmarked(bullet)));
  }
  return items;
}

function proposedItem(bullet: string): ProposedItem {
  const arrow = /^(.*?)\s*(?:->|→)\s*(.*)$/.exec(bullet);
  if (arrow === null) return { text: bullet };
  const [, text = "", target = ""] = arrow;
  const destination = parseDestination(target);
  return destination === undefined ? { text } : { text, destination };
}

function parseDestination(target: string): Destination | undefined {
  const filed = /^filed\s+(\S+)$/i.exec(target)?.[1];
  if (filed !== undefined) return { kind: "filed", id: filed };
  const [, kind, reason = ""] = /^(pending|dropped):?\s*(.*)$/i.exec(target) ?? [];
  if (kind === undefined) return undefined;
  return { kind: kind.toLowerCase() as "pending" | "dropped", reason: reason.trim() };
}

function destinationProblem({ text, destination }: ProposedItem): string | undefined {
  if (destination === undefined) return `proposed task "${text}" has no destination (filed <id>, pending: <reason> or dropped: <reason>)`;
  if (destination.kind === "pending" && destination.reason === "") return `proposed task "${text}" is pending with no reason`;
  if (destination.kind === "dropped" && !(DROP_REASONS as readonly string[]).includes(destination.reason)) {
    return `proposed task "${text}" is dropped for "${destination.reason}", not one of ${DROP_REASONS.join(", ")}`;
  }
  return undefined;
}

const CONTRACT_OPS = ["replace", "remove", "rename", "migrate", "add", "extend", "modify"] as const;

const Contract = z.object({
  scope: z.string().trim().min(1),
  op: z.enum(CONTRACT_OPS),
});
type Contract = z.infer<typeof Contract>;

const PlannedSlice = z.object({
  n: z.string().min(1),
  title: z.string(),
  dependsOn: z.array(z.string()).default([]),
  owns: z.array(z.string()).default([]),
  /** The checkout's basename or path when the work is not in the task's own repo. */
  repo: z.string().optional(),
  points: z.number().optional(),
  doneWhen: z.string().optional(),
  contracts: z.array(Contract).default([]),
  /** The ops the slice's doneWhen names; `[]` says its hits are subject matter. */
  ops: z.array(z.enum(OPS)).optional(),
  /** The semantic reason a slice waits on one whose owns it does not share. */
  dependsWhy: z.string().optional(),
});
/** `contracts` is optional on the type so fixtures built by hand stay valid; `readSlices` always fills it. */
export type PlannedSlice = Omit<z.infer<typeof PlannedSlice>, "contracts"> & { contracts?: Contract[] };

/** A planner's slices and their advisory lines when they pass the lint, else the reason lines. */
type SliceRead =
  | { slices: PlannedSlice[]; warnings: string[]; problems?: undefined }
  | { slices?: undefined; warnings?: undefined; problems: string[] };

const SLICES_BLOCK = /^```burndown-slices[ \t]*\n([\s\S]*?)^```[ \t]*$/m;

/** The planner's slices, or why the plan's `burndown-slices` block is missing, unreadable, or fails the lint. */
export function readSlices(planText: string): SliceRead {
  const body = SLICES_BLOCK.exec(planText)?.[1];
  if (body === undefined) return { problems: ["plan has no burndown-slices block"] };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch (err) {
    return { problems: [`burndown-slices block is not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const parsed = z.array(PlannedSlice).min(1).safeParse(json);
  if (!parsed.success) return { problems: parsed.error.issues.map(shapeProblem) };
  const problems = lintSlices(parsed.data);
  return problems.length === 0 ? { slices: parsed.data, warnings: sliceWarnings(parsed.data) } : { problems };
}

const shapeProblem = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0 ? `burndown-slices block: ${issue.message}` : `burndown-slices block at ${issue.path.join(".")}: ${issue.message}`;

/** True for a plan that is sliced, even when its block is unreadable or fails the lint. */
export const hasSlicesBlock = (planText: string): boolean => SLICES_BLOCK.test(planText);

/** The planner's slices, or undefined when `readSlices` finds a problem. */
export const parseSlices = (planText: string): PlannedSlice[] | undefined => readSlices(planText).slices;
