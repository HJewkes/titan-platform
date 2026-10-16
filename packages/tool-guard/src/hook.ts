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
import { MAX_NESTING } from "./shell/nesting.js";
import { ADDED_SCRIPT_WEIGHT, EnvSplitError, MAX_SCRIPT_BYTES, NestingReadingError, ReadingLimitError, ScriptBudgetError, SplicedReadingError, SplitReadingError, UnknownStdinError, UntrackedWriteError, ValueWalkError } from "./shell/unsure-readings.js";
import type { ScriptOverrun } from "./shell/unsure-readings.js";
import type { Split } from "./shell/parse-error.js";
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
type Clock = Pick<HookPort, "now">;
type Event = Exclude<HookEvent, { kind: "other" }>;
/** A decision's logged fields; an unclassified command logs action `unparsed` or `oversize` and spelling `<kind>.<action>`. */
type Logged = Omit<Matched, "action" | "spelling"> & { action: string; spelling: string };
/** A failure past one of classify's limits carries the reason the deny gives. */
type Classified = { ok: true; actions: ClassifiedAction[] } | { ok: false; cls: ErrorClass; limit?: string };
/** Why an answer never came: it ran past the hook's deadline, or the thread computing it died. */
export type Unfinished = "timeout" | "crash";

const PASS: HookResult = { stdout: "", log: [] };
const UNREADABLE_REASON =
  "authority-guard could not parse this Bash command, so it refuses it: text it cannot read can hide a push or merge from the check. Close every quote, `$(` and backtick, flatten nested substitutions into variables, or split it into simpler commands.";
const UNPARSED_REASON =
  "authority-guard could not parse this command and it names a guarded action or path; split it into simpler commands.";
const OVERSIZE_REASON =
  "authority-guard does not check a Bash command over 8 KiB, so it refuses every one; split it into shorter commands, or write the steps to a script file and run that.";
const READINGS_REASON =
  "authority-guard does not check a Bash command with this many variables in wrapper positions (`sudo $a`, `timeout $T`), so it refuses every one; split it into shorter commands, or write the steps to a script file and run that.";
const VALUE_REASON =
  "authority-guard does not check this Bash command: it evaluates arithmetic (`(( X ))`, `let X`, `a[X]=1`), which runs a `$(` or backquote after a `[` in a variable's value, and it stores such text where the check cannot follow it (`read`, an argument, a loop item, a value built at run time) or in a value it cannot read in full; write the commands out where they run, or split the arithmetic into its own command.";
const SPLIT_REASONS: Record<Split, string> = {
  heredoc:
    "authority-guard does not check this Bash command: a heredoc opened inside `$( )` or `<( )` is still open when it closes, so bash 5 reads its body, and the line's other heredoc bodies, from the next lines, while bash 3.2 runs those lines as commands; close the heredoc inside the substitution.",
  "procsub-brace":
    "authority-guard does not check this Bash command: bash 3.2 reads the text of a `<( )` or `>( )` in `${ }` as part of the parameter, and here a `}` or a quote in it ends that reading somewhere bash 5 does not; move the process substitution out of the parameter.",
  "nested-substitution":
    "authority-guard does not check this Bash command: bash 3.2 ends a `$( )` inside `${ }` or `$(( ))` at the first `)` that balances its parens, blind to heredocs, comments and case patterns, and here that is not where bash 5 ends it; move the command substitution out of the expansion.",
  "quoted-substitution":
    "authority-guard does not check this Bash command: a single-quoted span in `${ }` holds an unclosed `$(` or backtick, which bash reads as literal text unless the `${ }` sits in double quotes; close the substitution or move it out of the parameter.",
  "unclosed-expansion":
    "authority-guard does not check this Bash command: it cannot find where a `${ }`, `$(( ))` or `$[ ]` ends, and bash may close it elsewhere, fail only when expanding it, and run the rest of the line; close the expansion or move it into a variable.",
};
const NESTING_REASON = `authority-guard does not check a Bash command whose expansions or substitutions are nested more than ${MAX_NESTING} deep, so it refuses every one; flatten the nesting into variables or a script file.`;
const SPLICED_REASON =
  "authority-guard does not check this Bash command: its `eval` and `-c` texts, read again with what their substitutions print, add more text than it checks, as nested `eval \"$(…);…\"` doubles them at every level; flatten the nesting, or write the steps to a script file and run that.";
const UNTRACKED_REASON =
  "authority-guard does not check this Bash command: it writes a file the guard cannot follow (output it cannot reproduce, a target only known at run time, another fd, `>!`, `<>`), then runs a script, which may be that file; run the script in its own command, where the guard reads the file as it is.";
const ENV_SPLIT_REASON =
  "authority-guard does not check this `env -S` string: its words are only known at run time (a variable, an escape, an unclosed quote, or a `${NAME}` among env's options or as its command), so it refuses it; pass the command to env as separate words.";
const STDIN_REASON =
  "authority-guard does not check this Bash command: a shell runs its stdin or another descriptor as its script, and the line does not show that text (`bash < $F`, `bash /dev/stdin <&3`, `bash /dev/fd/3`); run the script by a literal path, so the guard reads the file.";
const TABLE_REASON = "authority-guard could not load the authority table, so it refuses every guarded action. Report this to the owner.";
const UNFINISHED_REASONS: Record<Unfinished, string> = {
  timeout: "authority-guard could not finish checking this call in time, so it was not run. Split the command into smaller Bash calls.",
  crash: "authority-guard stopped before it finished checking this call, so it was not run. Split the command into smaller Bash calls; if a short call is refused too, report this to the owner.",
};
const GUARDED_KEYWORDS = ["gh pr merge", "/merge", "publish", "deploy", "gist"];
/**
 * Classifying costs about 50 ms per KiB of arguments, so a padded command would only reach the
 * deadline deny after seconds. Every command over this size denies at once, whatever it names, because
 * quoting and variables hide a guarded name from any check of the raw text.
 */
export const MAX_COMMAND_BYTES = 8 * 1024;

/**
 * Answers one PreToolUse event. Never throws and never asks or allows: it either denies through
 * the returned stdout or stays silent. A Bash command it cannot classify denies; any other failure
 * fails open unless the raw text names something guarded (plan section 7, owner decision D6).
 */
export async function handle(input: string, env: Env, port: HookPort): Promise<HookResult> {
  try {
    return await answer(input, env, port);
  } catch {
    return exceptionResult(port);
  }
}

/**
 * The answer for an event whose check never finished. It denies whatever the event is: an allow
 * would let a command padded to outrun the check run unchecked (TP-3224). Never throws.
 */
export function unfinishedResult(input: string, env: Env, now: () => Date, why: Unfinished): HookResult {
  const reason = UNFINISHED_REASONS[why];
  try {
    const event = parseInput(input);
    if (event.kind === "malformed" || event.kind === "other") return { stdout: denyAnswer(reason), log: [] };
    return unclassified(event, observeActor(env, event.sessionId), why, reason, { now });
  } catch {
    return { stdout: denyAnswer(reason), log: [] };
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
  if (error instanceof NestingReadingError) return NESTING_REASON;
  if (error instanceof ValueWalkError) return VALUE_REASON;
  if (error instanceof SplicedReadingError) return SPLICED_REASON;
  if (error instanceof UntrackedWriteError) return UNTRACKED_REASON;
  if (error instanceof EnvSplitError) return ENV_SPLIT_REASON;
  if (error instanceof UnknownStdinError) return STDIN_REASON;
  return error instanceof SplitReadingError ? SPLIT_REASONS[error.split] : READINGS_REASON;
}

/** The limit a line's scripts hit, how far past it they go, and a split that then passes. */
function scriptsReason(o: ScriptOverrun): string {
  const kib = (bytes: number) => `${Math.ceil(bytes / 1024)} KiB`;
  if (o.added && o.bytes * ADDED_SCRIPT_WEIGHT > MAX_SCRIPT_BYTES) {
    return `authority-guard reads at most ${kib(MAX_SCRIPT_BYTES / ADDED_SCRIPT_WEIGHT)} of a script that only a variable in a wrapper position runs (\`$SUDO ./x.sh\`, \`timeout $T ./x.sh\`), and ${o.script} holds ${kib(o.bytes)}, so it refuses this command; write the wrapper out (\`sudo ./x.sh\`, \`timeout 5 ./x.sh\`) or run the script directly, so it is read as written.`;
  }
  return `authority-guard checks at most ${kib(MAX_SCRIPT_BYTES)} of script text in one command, counting a script that only a variable in a wrapper position runs ${ADDED_SCRIPT_WEIGHT} times, and this command's scripts reach ${kib(o.total)} at ${o.script}, so it refuses it; run ${o.script} in its own command.`;
}

/**
 * A Bash command that could not be classified always denies: quoting, ANSI-C strings and expansions spell
 * `git push` in ways no check of the raw text can find (TP-2174). A path denies only when it names
 * something guarded (D6).
 */
function failed(event: Event, actor: ActorObservation, cls: ErrorClass, port: HookPort): HookResult {
  const error = () => logged(formatErrorLine({ ts: port.now(), cls, tool: event.toolName, session: event.sessionId }));
  if (event.kind === "bash") return unclassified(event, actor, "unparsed", UNREADABLE_REASON, port);
  if (!namesGuarded(event.path)) return error();
  return unclassified(event, actor, "unparsed", UNPARSED_REASON, port);
}

/** Too large to check: an 8 KiB command, or one with more dynamic wrapper readings than classify walks. */
function oversized(event: Event, actor: ActorObservation, reason: string, port: HookPort): HookResult {
  return unclassified(event, actor, "oversize", reason, port);
}

function unclassified(event: Event, actor: ActorObservation, action: string, reason: string, port: Clock): HookResult {
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
  return PASS;
}

function tableFailure(event: Event, actor: ActorObservation, actions: ClassifiedAction[], port: HookPort): HookResult {
  const first = actions[0] as ClassifiedAction;
  const matched: Logged = { ruleId: null, action: first.action, spelling: first.spelling, subject: first.subject };
  const error = formatErrorLine({ ts: port.now(), cls: "table", tool: event.toolName, session: event.sessionId });
  return { stdout: denyAnswer(TABLE_REASON), log: [error, decisionLine(event, actor, matched, "deny", port)] };
}

function decisionLine(event: Event, actor: ActorObservation, m: Logged, kind: "deny", port: Clock): string {
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
