import { observeActor } from "./actor.js";
import type { ActorObservation } from "./actor.js";
import { classify } from "./classify.js";
import type { GuardDecision, Matched } from "./decide.js";
import { parseHookEvent } from "./event.js";
import type { HookEvent, MalformedEvent } from "./event.js";
import { formatDecisionLine, formatErrorLine } from "./log.js";
import type { ErrorClass } from "./log.js";
import { GUARDED_PATHS } from "./paths.js";
import { ParseError } from "./shell/lexer.js";
import type { ClassifiedAction, ClassifyContext } from "./types.js";

export type DecideFn = (actions: readonly ClassifiedAction[], actor: ActorObservation) => GuardDecision;

export interface HookPort {
  context: ClassifyContext;
  now(): Date;
  /** Loads the authority table lazily, so a broken table fails closed only for events that classify. */
  loadDecide(): Promise<DecideFn>;
}

/** What the bin prints on stdout (empty, or one deny answer) and the lines it appends to the log. */
export interface HookResult {
  stdout: string;
  log: string[];
}

type Env = Readonly<Record<string, string | undefined>>;
type Event = Exclude<HookEvent, { kind: "other" }>;
/** A decision's logged fields; an unclassified command logs action `unparsed` or `oversize` and spelling `<kind>.<action>`. */
type Logged = Omit<Matched, "action" | "spelling"> & { action: string; spelling: string };
type Classified = { ok: true; actions: ClassifiedAction[] } | { ok: false; cls: ErrorClass };

const PASS: HookResult = { stdout: "", log: [] };
const UNPARSED_REASON =
  "authority-guard could not parse this command and it names a guarded action or path; split it into simpler commands.";
const OVERSIZE_REASON =
  "authority-guard does not classify a command this long and it names a guarded action or path; split it into shorter commands.";
const TABLE_REASON = "authority-guard could not load the authority table, so it refuses every guarded action. Report this to the owner.";
const GUARDED_KEYWORDS = ["gh pr merge", "/merge", "publish", "deploy", "gist"];
/**
 * Classifying costs about 50 ms per KiB of arguments, so padding a command past Claude Code's 5 s
 * hook timeout would let it run. Over this size the raw text alone decides, as for a parse error.
 */
export const MAX_COMMAND_BYTES = 8 * 1024;

/**
 * Answers one PreToolUse event. Never throws and never asks or allows: it either denies through
 * the returned stdout or stays silent. Failures fail open unless the raw text names something
 * guarded (plan section 7, owner decision D6).
 */
export async function handle(input: string, env: Env, port: HookPort): Promise<HookResult> {
  try {
    return await answer(input, env, port);
  } catch {
    return exceptionResult(port);
  }
}

function exceptionResult(port: HookPort): HookResult {
  try {
    return logged(formatErrorLine({ ts: port.now(), cls: "exception", tool: null, session: null }));
  } catch {
    return PASS;
  }
}

async function answer(input: string, env: Env, port: HookPort): Promise<HookResult> {
  const event = parseInput(input);
  if (event.kind === "malformed") return logged(formatErrorLine({ ts: port.now(), cls: "shape", tool: event.toolName, session: null }));
  if (event.kind === "other") return PASS;
  const actor = observeActor(env, event.sessionId);
  if (event.kind === "bash" && Buffer.byteLength(event.command) > MAX_COMMAND_BYTES) return failed(event, actor, "oversize", port);
  const result = classifyEvent(event, port.context);
  if (!result.ok) return failed(event, actor, result.cls, port);
  if (result.actions.length === 0) return PASS;
  return decided(event, actor, result.actions, port);
}

function parseInput(input: string): HookEvent | MalformedEvent {
  try {
    return parseHookEvent(JSON.parse(input));
  } catch {
    return { kind: "malformed", toolName: null };
  }
}

function classifyEvent(event: Event, ctx: ClassifyContext): Classified {
  try {
    return { ok: true, actions: classify(event, ctx) };
  } catch (error) {
    return { ok: false, cls: error instanceof ParseError ? "parse" : "exception" };
  }
}

/** A command or path that was not classified denies only when its raw text names something guarded. */
function failed(event: Event, actor: ActorObservation, cls: ErrorClass, port: HookPort): HookResult {
  const error = formatErrorLine({ ts: port.now(), cls, tool: event.toolName, session: event.sessionId });
  const raw = event.kind === "bash" ? event.command : event.path;
  if (actor.bypass || !namesGuarded(raw)) return logged(error);
  const action = cls === "oversize" ? "oversize" : "unparsed";
  const unclassified: Logged = { ruleId: null, action, spelling: `${event.kind}.${action}`, subject: {} };
  const reason = cls === "oversize" ? OVERSIZE_REASON : UNPARSED_REASON;
  return { stdout: denyAnswer(reason), log: [decisionLine(event, actor, unclassified, "deny", port)] };
}

async function decided(event: Event, actor: ActorObservation, actions: ClassifiedAction[], port: HookPort): Promise<HookResult> {
  let decision: GuardDecision;
  try {
    decision = (await port.loadDecide())(actions, actor);
  } catch {
    return tableFailure(event, actor, actions, port);
  }
  if (decision.outcome === "deny") return { stdout: denyAnswer(decision.reason), log: [decisionLine(event, actor, decision, "deny", port)] };
  if (actor.bypass && decision.matched) return logged(decisionLine(event, actor, decision.matched, "bypass", port));
  return PASS;
}

function tableFailure(event: Event, actor: ActorObservation, actions: ClassifiedAction[], port: HookPort): HookResult {
  const first = actions[0] as ClassifiedAction;
  const matched: Logged = { ruleId: null, action: first.action, spelling: first.spelling, subject: first.subject };
  const error = formatErrorLine({ ts: port.now(), cls: "table", tool: event.toolName, session: event.sessionId });
  return { stdout: denyAnswer(TABLE_REASON), log: [error, decisionLine(event, actor, matched, "deny", port)] };
}

function decisionLine(event: Event, actor: ActorObservation, m: Logged, kind: "deny" | "bypass", port: HookPort): string {
  return formatDecisionLine({
    ts: port.now(),
    kind,
    rule: m.ruleId,
    action: m.action,
    spelling: m.spelling,
    actor: actor.candidates,
    actorId: actor.id,
    session: event.sessionId,
    tool: event.toolName,
    toolUse: event.toolUseId,
    subject: m.subject,
  });
}

function denyAnswer(reason: string): string {
  const permissionDecisionReason = reason.replace(/\s+/g, " ");
  const answer = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason } };
  return JSON.stringify(answer);
}

function logged(line: string): HookResult {
  return { stdout: "", log: [line] };
}

/** Literal stems of every guarded pattern, its distinctive basenames, and the merge and release keywords. */
const GUARDED_NEEDLES: readonly string[] = [
  ...[...GUARDED_PATHS.secret.paths, ...GUARDED_PATHS.config.paths].map((p) => literalStem(p.pattern)),
  ...GUARDED_PATHS.secret.basenames,
  ...GUARDED_KEYWORDS,
].map((needle) => needle.toLowerCase());

function literalStem(pattern: string): string {
  const bare = pattern.replace(/^(~\/|\*\*\/)/, "");
  return bare.slice(0, bare.search(/[*?[]|$/)).replace(/\/$/, "");
}

/** Case-folded, because a case-insensitive filesystem opens `~/.NPMRC` as `~/.npmrc`. */
export function namesGuarded(raw: string): boolean {
  const text = raw.toLowerCase();
  return GUARDED_NEEDLES.some((needle) => needle !== "" && text.includes(needle));
}
