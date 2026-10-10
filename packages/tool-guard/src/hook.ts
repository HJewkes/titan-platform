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
import { ADDED_SCRIPT_WEIGHT, MAX_SCRIPT_BYTES, ReadingLimitError, ScriptBudgetError, SplitReadingError, ValueWalkError } from "./shell/unsure-readings.js";
import type { ScriptOverrun } from "./shell/unsure-readings.js";
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
/** A failure past one of classify's limits carries the reason the deny gives. */
type Classified = { ok: true; actions: ClassifiedAction[] } | { ok: false; cls: ErrorClass; limit?: string };

const PASS: HookResult = { stdout: "", log: [] };
const UNPARSED_REASON =
  "authority-guard could not parse this command and it names a guarded action or path; split it into simpler commands.";
const OVERSIZE_REASON =
  "authority-guard does not check a Bash command over 8 KiB, so it refuses every one; split it into shorter commands, or write the steps to a script file and run that.";
const READINGS_REASON =
  "authority-guard does not check a Bash command with this many variables in wrapper positions (`sudo $a`, `timeout $T`), so it refuses every one; split it into shorter commands, or write the steps to a script file and run that.";
const VALUE_REASON =
  "authority-guard does not check this Bash command: it evaluates arithmetic (`(( X ))`, `let X`, `a[X]=1`), which runs a `$(` or backquote after a `[` in a variable's value, and it stores such text where the check cannot follow it (`read`, an argument, a loop item, a value built at run time) or in a value it cannot read in full; write the commands out where they run, or split the arithmetic into its own command.";
const SPLIT_REASON =
  "authority-guard does not check this Bash command: a heredoc opened inside `$( )` or `<( )` is still open when it closes, so bash 5 reads its body, and the line's other heredoc bodies, from the next lines, while bash 3.2 runs those lines as commands; close the heredoc inside the substitution.";
const TABLE_REASON = "authority-guard could not load the authority table, so it refuses every guarded action. Report this to the owner.";
const GUARDED_KEYWORDS = ["gh pr merge", "/merge", "publish", "deploy", "gist"];
/**
 * Classifying costs about 50 ms per KiB of arguments, so padding a command past Claude Code's 5 s
 * hook timeout would let it run. Every command over this size denies, whatever it names, because
 * quoting and variables hide a guarded name from any check of the raw text.
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
  if (event.kind === "bash" && Buffer.byteLength(event.command) > MAX_COMMAND_BYTES) return oversized(event, actor, OVERSIZE_REASON, port);
  const result = classifyEvent(event, port.context);
  if (!result.ok && result.limit) return oversized(event, actor, result.limit, port);
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
    if (error instanceof ReadingLimitError) return { ok: false, cls: "oversize", limit: limitReason(error) };
    return { ok: false, cls: error instanceof ParseError ? "parse" : "exception" };
  }
}

function limitReason(error: ReadingLimitError): string {
  if (error instanceof ScriptBudgetError) return scriptsReason(error.overrun);
  if (error instanceof ValueWalkError) return VALUE_REASON;
  return error instanceof SplitReadingError ? SPLIT_REASON : READINGS_REASON;
}

/** The limit a line's scripts hit, how far past it they go, and a split that then passes. */
function scriptsReason(o: ScriptOverrun): string {
  const kib = (bytes: number) => `${Math.ceil(bytes / 1024)} KiB`;
  if (o.added && o.bytes * ADDED_SCRIPT_WEIGHT > MAX_SCRIPT_BYTES) {
    return `authority-guard reads at most ${kib(MAX_SCRIPT_BYTES / ADDED_SCRIPT_WEIGHT)} of a script that only a variable in a wrapper position runs (\`$SUDO ./x.sh\`, \`timeout $T ./x.sh\`), and ${o.script} holds ${kib(o.bytes)}, so it refuses this command; write the wrapper out (\`sudo ./x.sh\`, \`timeout 5 ./x.sh\`) or run the script directly, so it is read as written.`;
  }
  return `authority-guard checks at most ${kib(MAX_SCRIPT_BYTES)} of script text in one command, counting a script that only a variable in a wrapper position runs ${ADDED_SCRIPT_WEIGHT} times, and this command's scripts reach ${kib(o.total)} at ${o.script}, so it refuses it; run ${o.script} in its own command.`;
}

/** A command or path that could not be classified denies only when its text names something guarded (D6). */
function failed(event: Event, actor: ActorObservation, cls: ErrorClass, port: HookPort): HookResult {
  const raw = event.kind === "bash" ? event.command : event.path;
  if (actor.bypass || !namesGuarded(raw)) return logged(formatErrorLine({ ts: port.now(), cls, tool: event.toolName, session: event.sessionId }));
  return unclassified(event, actor, "unparsed", UNPARSED_REASON, port);
}

/** Too large to check: an 8 KiB command, or one with more dynamic wrapper readings than classify walks. */
function oversized(event: Event, actor: ActorObservation, reason: string, port: HookPort): HookResult {
  if (actor.bypass) return logged(formatErrorLine({ ts: port.now(), cls: "oversize", tool: event.toolName, session: event.sessionId }));
  return unclassified(event, actor, "oversize", reason, port);
}

function unclassified(event: Event, actor: ActorObservation, action: string, reason: string, port: HookPort): HookResult {
  const fields: Logged = { ruleId: null, action, spelling: `${event.kind}.${action}`, subject: {} };
  return { stdout: denyAnswer(reason), log: [decisionLine(event, actor, fields, "deny", port)] };
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

/**
 * Whether the text, as typed or with shell quoting removed and whitespace runs collapsed, holds a
 * guarded name: `gh pr mer''ge` and `gh  pr  merge` both count. Case-folded, because a
 * case-insensitive filesystem opens `~/.NPMRC` as `~/.npmrc`. Variables and globs are not expanded.
 */
export function namesGuarded(raw: string): boolean {
  const texts = [raw, unquoted(raw)].map((t) => t.toLowerCase());
  return GUARDED_NEEDLES.some((needle) => needle !== "" && texts.some((t) => t.includes(needle)));
}

function unquoted(raw: string): string {
  return raw.replace(/\\(.)/gs, "$1").replace(/['"]/g, "").replace(/\s+/g, " ");
}
