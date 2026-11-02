/**
 * Parses a spawned agent's final message under the return contract: the first line (`Status:` for workers,
 * `Verdict:` for reviewers), the `PR:`, `Head:`, `CI:` and `Plan:` lines, a closing `PARKED <msgId>` line and a
 * `Proposed tasks:` block. Anything the parser cannot read is `unknown`, never a guess at success.
 */

export const REPORT_STATUSES = ["DONE", "DONE_WITH_CONCERNS", "BLOCKED", "NEEDS_CONTEXT"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
type Verdict = "APPROVE" | "CHANGES";

export const CI_STATES = ["fail", "pending", "pass", "none", "unknown"] as const;
export type CiState = (typeof CI_STATES)[number];

export interface ContractReport {
  status: ReportStatus | "unknown";
  verdict?: Verdict;
  /** The message id of the `chat_ask` a parked worker filed. */
  parked?: string;
  pr?: string;
  /** The full or short sha on the report's `Head:` line. */
  head?: string;
  /** The `CI:` line and the `gh pr checks` paste under it, read worst first. */
  ci?: { state: CiState; text: string };
  /** A planner's plan file, from its `Plan: <absolute path>` line. */
  plan?: string;
  /** The items of a `Proposed tasks:` block, absent when the report has none. */
  proposed?: ProposedItem[];
  /** Why the report is refused (decision 331): the first proposed item with no valid destination. */
  refused?: string;
  firstLine: string;
  text: string;
}

const isStatus = (value: string | undefined): value is ReportStatus => (REPORT_STATUSES as readonly (string | undefined)[]).includes(value);

const unmarked = (line: string): string => line.replace(/[*`]/g, "").trim();

/** The status word may be followed by a sentence (`Status: DONE. Plan: ...`); only a known word counts. */
const STATUS_LINE = /^Status:\s*([A-Za-z_]+)(?![A-Za-z_])/;

export function parseReport(text: string): ContractReport {
  const lines = text
    .split("\n")
    .map(unmarked)
    .filter((line) => line.length > 0);
  const firstLine = lines[0] ?? "";
  const report: ContractReport = { status: "unknown", firstLine, text };
  const status = STATUS_LINE.exec(firstLine)?.[1]?.toUpperCase();
  if (isStatus(status)) report.status = status;
  const verdict = /^Verdict:\s*(APPROVE|CHANGES)\s*$/.exec(firstLine)?.[1];
  if (verdict === "APPROVE" || verdict === "CHANGES") report.verdict = verdict;
  const parked = /^PARKED\s+(\S+)$/.exec(lines.at(-1) ?? "")?.[1];
  if (parked !== undefined) report.parked = parked;
  Object.assign(report, headerFields(lines));
  const proposed = proposedItems(text);
  if (proposed !== undefined) {
    report.proposed = proposed;
    const refused = proposed.map(destinationProblem).find((problem) => problem !== undefined);
    if (refused !== undefined) report.refused = refused;
  }
  return report;
}

function headerFields(lines: string[]): Pick<ContractReport, "pr" | "head" | "ci" | "plan"> {
  const fields: Pick<ContractReport, "pr" | "head" | "ci" | "plan"> = {};
  const pr = field(lines, "PR");
  if (pr !== undefined) fields.pr = pr;
  const head = /^([0-9a-f]{7,40})\b/.exec(field(lines, "Head") ?? "")?.[1];
  if (head !== undefined) fields.head = head;
  const ci = ciBlock(lines);
  if (ci !== undefined) fields.ci = { state: ciState(ci), text: ci };
  const plan = field(lines, "Plan");
  if (plan !== undefined) fields.plan = plan;
  return fields;
}

const field = (lines: string[], label: string): string | undefined =>
  lines.map((line) => new RegExp(`^${label}:\\s*(\\S.*?)\\s*$`).exec(line)?.[1]).find((value) => value !== undefined);

/** A label that ends the `CI:` paste: the contract's later fields, or any `Word:` line that is not a check row. */
const NEXT_FIELD = /^(?:Concerns|Notes|Friction|Shepherd|Proposed tasks|PARKED)\b|^[A-Z][\w -]{0,30}:(?:\s|$)/;

function ciBlock(lines: string[]): string | undefined {
  const at = lines.findIndex((line) => /^CI:/.test(line));
  if (at === -1) return undefined;
  const rest = lines.slice(at + 1);
  const end = rest.findIndex((line) => NEXT_FIELD.test(line));
  return [lines[at]!.replace(/^CI:\s*/, ""), ...rest.slice(0, end === -1 ? rest.length : end)].join("\n").trim();
}

/** A failing check outweighs a pending one, which outweighs a pass, so one red row is never read as green. */
function ciState(ci: string): CiState {
  if (/\bfail(?:s|ed|ing|ure)?\b/i.test(ci)) return "fail";
  if (/\b(?:pending|queued|in[_ ]progress|running|waiting)\b/i.test(ci)) return "pending";
  if (/\b(?:pass|passed|passing|success|green)\b/i.test(ci)) return "pass";
  if (/^(?:none|n\/a|no checks?|no pr)\b/i.test(ci)) return "none";
  return "unknown";
}

/** The reasons a proposed task may be dropped without filing it (decision 331). */
export const DROP_REASONS = ["duplicate", "already-done", "out-of-scope", "superseded"] as const;

type Destination = { kind: "filed"; id: string } | { kind: "pending"; reason: string } | { kind: "dropped"; reason: string };

export interface ProposedItem {
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
  const [, kind = "", reason = ""] = /^(pending|dropped):?\s*(.*)$/i.exec(target) ?? [];
  if (/^pending$/i.test(kind)) return { kind: "pending", reason: reason.trim() };
  if (/^dropped$/i.test(kind)) return { kind: "dropped", reason: reason.trim() };
  return undefined;
}

function destinationProblem({ text, destination }: ProposedItem): string | undefined {
  if (destination === undefined) return `proposed task "${text}" has no destination (filed <id>, pending: <reason> or dropped: <reason>)`;
  if (destination.kind === "pending" && destination.reason === "") return `proposed task "${text}" is pending with no reason`;
  if (destination.kind === "dropped" && !(DROP_REASONS as readonly string[]).includes(destination.reason)) {
    return `proposed task "${text}" is dropped for "${destination.reason}", not one of ${DROP_REASONS.join(", ")}`;
  }
  return undefined;
}
