import type { ActorClass } from "@titan-design/authority";

/** The fixed fields of a deny or bypass line, in log order. Nothing else is ever written. */
export interface DecisionLine {
  ts: Date;
  kind: "deny" | "bypass";
  rule: string | null;
  action: string;
  spelling: string;
  actor: readonly ActorClass[];
  actorId: string;
  session: string | null;
  tool: string;
  toolUse: string | null;
  subject: Record<string, string>;
}

export type ErrorClass = "parse" | "shape" | "table" | "exception" | "oversize";

export interface ErrorLine {
  ts: Date;
  cls: ErrorClass;
  tool: string | null;
  session: string | null;
}

/** The subject keys families emit; any other key is dropped rather than logged. */
const SUBJECT_KEYS: ReadonlySet<string> = new Set(["pattern", "pr", "branch", "tool", "host"]);
const TOKEN_RE = /[A-Za-z0-9_+=-]{24,}/g;
const UNSAFE_RE = /[^\w.:@/+=-]/g;

export function formatDecisionLine(line: DecisionLine): string {
  const fields = [
    line.ts.toISOString(),
    line.kind,
    line.rule ?? "none",
    line.action,
    line.spelling,
    line.actor.join("+"),
    line.actorId,
    line.session ?? "-",
    line.tool,
    line.toolUse ?? "-",
    formatSubject(line.subject),
  ];
  return fields.map(field).join("\t");
}

export function formatErrorLine(line: ErrorLine): string {
  return [line.ts.toISOString(), "error", line.cls, line.tool ?? "-", line.session ?? "-"].map(field).join("\t");
}

/** Safe keys only, and any value that could carry a secret typed into the command is cut. */
function formatSubject(subject: Record<string, string>): string {
  const pairs = Object.entries(subject).filter(([key]) => SUBJECT_KEYS.has(key));
  if (pairs.length === 0) return "-";
  return pairs.map(([key, value]) => `${key}=${value.replace(UNSAFE_RE, "_").replace(TOKEN_RE, "<cut>").slice(0, 80)}`).join(",");
}

/** A field never breaks the line: tabs, newlines and other control characters become `_`. */
function field(value: string): string {
  return value === "" ? "-" : value.replace(/[\s\p{Cc}]/gu, "_");
}

/** `$TITAN_TOOL_GUARD_LOG`, else `${XDG_STATE_HOME:-$HOME/.local/state}/titan-tool-guard/guard.log`. */
export function logPath(env: Readonly<Record<string, string | undefined>>, home: string): string {
  if (env.TITAN_TOOL_GUARD_LOG) return env.TITAN_TOOL_GUARD_LOG;
  const state = env.XDG_STATE_HOME || `${home}/.local/state`;
  return `${state}/titan-tool-guard/guard.log`;
}
