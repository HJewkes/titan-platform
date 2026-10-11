import type { ToolUse } from "./transcript.js";
import { bashCommand, type Trigger } from "./turn-signals.js";

export type DutyKind = "det" | "judge" | "half" | "handoff" | "incident" | "other";

/** Matches the full command text; the first matching rule wins, so the order is part of the method. */
export interface BashRule {
  id: string;
  pattern: RegExp;
  /** Must also match. */
  also?: RegExp;
  /** Must not match. */
  unless?: RegExp;
  duty: string;
}

/** A tool input field a rule reads. `to` takes the first recipient of a list. */
export type ToolField = "name" | "message" | "to" | "file_path";

export interface ToolRule {
  id: string;
  /** Exact tool names, or `*suffix` for an MCP tool under any server prefix. */
  tools: readonly string[];
  when?: { field: ToolField; pattern: RegExp; also?: RegExp } | { field: "to"; recipient: "owner" };
  /** null stops the scan with the call left unclassified. */
  duty: string | null;
}

export interface DutyRuleSet {
  id: string;
  bash: readonly BashRule[];
  tools: readonly ToolRule[];
  /** The duty of an unclassified call in a turn with no classified call; a missing trigger falls to `other`. */
  triggerDefaults: Partial<Record<Trigger, string>>;
}

/** Who counts as the owner side of a send: matched as a prefix of the first recipient. */
export interface RuleContext {
  owners: readonly string[];
}

/** The first rule that gives the tool use a duty, or null. */
export function toolDuty(tool: ToolUse, rules: DutyRuleSet, context: RuleContext): string | null {
  if (tool.name === "Bash") return bashDuty(bashCommand(tool), rules.bash);
  const rule = rules.tools.find((candidate) => matchesTool(candidate, tool, context));
  return rule ? rule.duty : null;
}

function bashDuty(command: string, rules: readonly BashRule[]): string | null {
  const rule = rules.find(
    (candidate) => candidate.pattern.test(command) && (!candidate.also || candidate.also.test(command)) && !candidate.unless?.test(command),
  );
  return rule ? rule.duty : null;
}

function matchesTool(rule: ToolRule, tool: ToolUse, context: RuleContext): boolean {
  if (!rule.tools.some((name) => (name.startsWith("*") ? tool.name.endsWith(name.slice(1)) : tool.name === name))) return false;
  const when = rule.when;
  if (!when) return true;
  const value = fieldOf(tool, when.field);
  if ("recipient" in when) return context.owners.some((owner) => value.startsWith(owner));
  return when.pattern.test(value) && (!when.also || when.also.test(value));
}

function fieldOf(tool: ToolUse, field: ToolField): string {
  const raw = tool.input[field];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" ? value : "";
}

export const NOOP_PREFIX = "noop:";

/**
 * Kind and TP-1550 report row per duty, from report.py KIND and compare.py MAP. A row marked NEW has
 * no TP-1550 counterpart. NO-OP duties count as deterministic.
 */
const DUTY_CATALOG: Record<string, { kind: DutyKind; group: string }> = {
  handoff: { kind: "handoff", group: "handoff" },
  "triage-close": { kind: "det", group: "closeout" },
  "dispatch-select": { kind: "half", group: "selection" },
  "scope-verify": { kind: "half", group: "selection" },
  "dispatch-brief": { kind: "judge", group: "briefing" },
  "task-bookkeep": { kind: "det", group: "bookkeeping" },
  "ci-watch": { kind: "det", group: "CI watching" },
  "log-bookkeep": { kind: "det", group: "log/dispatch records" },
  pacing: { kind: "det", group: "pacing" },
  "timed-hold": { kind: "det", group: "pacing" },
  merge: { kind: "det", group: "merges" },
  "review-route": { kind: "det", group: "review routing" },
  "triage-read": { kind: "half", group: "report triage" },
  "peer-coord": { kind: "det", group: "peer coordination" },
  "seat-own-work": { kind: "judge", group: "seat own work" },
  "seat-file-upkeep": { kind: "judge", group: "seat own work" },
  "owner-comm": { kind: "judge", group: "owner comms" },
  "owner-decisions": { kind: "judge", group: "owner comms (decisions) NEW" },
  "shepherd-handops": { kind: "det", group: "Shepherd hand-ops NEW" },
  "shepherd-watch": { kind: "det", group: "Shepherd status reads NEW" },
  "shepherd-gates": { kind: "det", group: "Shepherd gate reads NEW" },
  "incident-migration": { kind: "incident", group: "incident/migration NEW" },
};

export function dutyInfo(duty: string): { kind: DutyKind; group: string } {
  if (duty.startsWith(NOOP_PREFIX)) return { kind: "det", group: "no-op ticks" };
  return DUTY_CATALOG[duty] ?? { kind: "other", group: duty };
}
