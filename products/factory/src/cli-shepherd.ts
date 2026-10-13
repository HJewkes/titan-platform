import type { JsonEnvelope } from "@titan-design/registry";
import type { Command } from "commander";
import type { CliIo, Verbs } from "./cli.js";
import { registerShepherdCoverage } from "./cli-coverage.js";
import { callerOf, parsePort, parsePositiveInt, parseTarget, statusRows, withStatusFilters, type StatusFilter } from "./cli-options.js";
import { localEnvelope, postRpc, unansweredMessage } from "./cli-shepherd-rpc.js";
import { registerShepherdWait } from "./cli-shepherd-wait.js";
import { registerShepherdStats } from "./cli-stats.js";
import { deployBlockOf, deploySummary, type DeployHealth } from "./deploy-health.js";
import { EXIT } from "./exit-codes.js";
import { parsePayload } from "./gate-resolve.js";
import { parsePrRef } from "./registry.js";
import { FACTORY_PORT } from "./serve.js";
import { reviewSlotsOf, reviewSlotsSummary } from "./review-slots-health.js";
import { probeServe } from "./serve-probe.js";
import { activeWorkOrigin } from "./shepherd/cleanup-ports.js";
import { SHEPHERD_COMMAND_MAP, type ShepherdCommandName } from "./shepherd/commands.js";
import { formatShepherd, lastEntries, type TimelineView } from "./shepherd/format.js";
import { inferIdentity } from "./shepherd/register-identity.js";
import { qualifyTask } from "./shepherd/task-ref.js";
import type { ReviewSlots } from "./shepherd/review-slots.js";
import { overdueOwnerGates, WaitingSchema } from "./shepherd/waiting.js";

interface ShepherdOpts extends TimelineView, StatusFilter {
  port: number;
  json?: boolean;
  offline?: boolean;
  deploy?: boolean;
}

type RegisterOpts = ShepherdOpts & { branch?: string; head?: string; base?: string; task?: string; implementer?: string; reviewer?: string; kind?: string; slice?: string | false; policy?: string };

/** The shepherd.* registry commands as verbs: on titan-factory serve when one answers, else against the database here; register needs --offline for that. */
export function registerShepherd(program: Command, verbs: Verbs): void {
  const shepherd = program.command("shepherd").description("shepherd PRs to a merge; gate resolve stays its own verb and is never a shepherd command");
  const verb: VerbOf = (spec, description) =>
    shepherd
      .command(spec)
      .description(description)
      .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
      .option("--json", "print the result as JSON");
  registerRunVerbs(verb, verbs);
  registerHoldVerbs(verb, verbs);
  registerShepherdStats(shepherd, verbs.io, verbs.dbPath, verbs.setExit);
  registerShepherdCoverage(shepherd, verbs.io, verbs.dbPath, verbs.setExit);
  registerShepherdWait(shepherd, verbs);
  registerRefVerbs(verb, verbs);
}

type VerbOf = (spec: string, description: string) => Command;

function registerRunVerbs(verb: VerbOf, verbs: Verbs): void {
  verb("register <target>", "shepherd owner/repo#N, or owner/repo with --branch before its PR exists; a repeat returns the existing run, or a new one if it failed")
    .option("--branch <name>", "the PR's head branch")
    .option("--head <sha>", "the PR's head commit; with --branch, Shepherd does not read the PR from GitHub to register it")
    .option("--base <name>", "the PR's base branch; with --head, Shepherd classes the PR's files from local git")
    .option("--task <slug/id>", "the task this PR delivers; defaults to the id in an agent-chat/<name> head branch")
    .option("--implementer <name>", "the agent that pushes fixes; defaults to <name> of an agent-chat/<name> head branch")
    .option("--reviewer <name>", "the agent that reviews")
    .option("--kind <kind>", "correctness, security, feature, refactor or unknown")
    .option("--slice <label>", "this PR is one slice of a multi-slice task: landing notes the task instead of closing it")
    .option("--no-slice", "clear a slice kept from an earlier registration")
    .option("--policy <json>", 'narrow the seat policy, e.g. {"merge":"never"}')
    .option("--offline", "record the run in the database here when no titan-factory serve answers; nothing drives it until serve starts")
    .action((target: string, opts: RegisterOpts) => runShepherd(verbs, "shepherd.register", () => registerArgs(target, opts, verbs), opts));
  withStatusFilters(verb("status [target]", "one line per shepherded PR, optionally only owner/repo or owner/repo#N, then serve's deploy and reviewer-slot lines"))
    .option("--deploy", "with --json, print { rows, deploy, reviewSlots } so serve's deploy block and reviewer-slot reading ride along; without it --json stays the bare row array")
    .action((target: string | undefined, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.status", () => (target ? parseTarget(target) : {}), opts));
  verb("list", "the watch list")
    .option("--state <state>", "active, finished or all", "active")
    .action((opts: ShepherdOpts & { state: string }) => runShepherd(verbs, "shepherd.list", () => ({ state: opts.state }), opts));
  verb("prs [repo]", "every open PR of each seat repo, or of owner/repo, from Shepherd's snapshot, plus the PRs it merged in the last 24 h")
    .action((repo: string | undefined, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.prs", () => (repo ? { repo } : {}), opts));
  verb("waiting", "every pending gate, oldest first: what waits on the owner, then seat work (ci-failed, sh-sent-back, stuck-behind)")
    .action((opts: ShepherdOpts) => runShepherd(verbs, "shepherd.waiting", () => ({}), opts));
}

function registerHoldVerbs(verb: VerbOf, verbs: Verbs): void {
  verb("hold <ref>", "hold owner/repo#N so no merge goes through until release")
    .requiredOption("--reason <text>", "why it is held")
    .option("--reviewer <name>", "the reviewer whose verdict the run waits for; the reason text never names one")
    .action((ref: string, opts: ShepherdOpts & { reason: string; reviewer?: string }) =>
      runShepherd(verbs, "shepherd.hold", () => ({ ...parsePrRef(ref), reason: opts.reason, reviewer: opts.reviewer, actor: callerOf(verbs.io.env) }), opts));
  verb("release <ref>", "release one hold on owner/repo#N at the head the seat reviewed; refused when the PR has moved past it")
    .requiredOption("--head <sha>", "the 40-character head sha the hold was reviewed at")
    .option("--class <class>", "the class of the hold to lift; needed only while a g10-adversary hold sits over another")
    .action((ref: string, opts: ShepherdOpts & { head: string; class?: string }) =>
      runShepherd(verbs, "shepherd.release", () => ({ ...parsePrRef(ref), head: opts.head, holdClass: opts.class, actor: callerOf(verbs.io.env) }), opts));
  verb("resync", "end runs and gates whose PR was merged or closed outside Shepherd, cancel gates of ended runs, supersede moved heads")
    .option("--dry-run", "print what it would end, cancel or supersede, and write nothing")
    .action((opts: ShepherdOpts & { dryRun?: boolean }) => runShepherd(verbs, "shepherd.resync", () => ({ dryRun: opts.dryRun === true }), opts));
}

function registerRefVerbs(verb: VerbOf, verbs: Verbs): void {
  verb("timeline <ref>", "every step and gate the run for owner/repo#N recorded")
    .option("--last <n>", "only the last n entries, noting how many earlier ones it cut; with --json, entries holds only those", parsePositiveInt)
    .option("--width <n>", "cut every text line to n characters", parsePositiveInt)
    .action((ref: string, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.timeline", () => parsePrRef(ref), opts));
  for (const [name, description] of PR_VERBS) {
    verb(`${name} <ref>`, description).action((ref: string, opts: ShepherdOpts) => runShepherd(verbs, `shepherd.${name}`, () => parsePrRef(ref), opts));
  }
}

const PR_VERBS = [
  ["merge", "evaluate a merge of owner/repo#N now; it resolves no gate"],
  ["review", "ask for Shepherd's own fresh review of owner/repo#N at its current head; a repeat at the same head asks nothing"],
] as const;

async function registerArgs(target: string, opts: RegisterOpts, { io, deps }: Verbs): Promise<Record<string, unknown>> {
  const policy = opts.policy === undefined ? undefined : parsePayload(opts.policy);
  if (opts.policy !== undefined && !policy) throw new Error("--policy must be a JSON object");
  const { branch, head, base, reviewer, kind, slice } = opts;
  const parsed = parseTarget(target);
  const { task: given, implementer } = await inferIdentity(parsed, opts, deps.headRef);
  const task = await qualifyTask(given, { origin: activeWorkOrigin(io.env), ...(deps.fetch && { fetch: deps.fetch }) });
  return { ...parsed, branch, head, base, task, implementer, reviewer, kind, slice: slice === false ? undefined : slice, noSlice: slice === false ? true : undefined, policy };
}

async function runShepherd(verbs: Verbs, name: ShepherdCommandName, argsOf: () => object | Promise<object>, opts: ShepherdOpts): Promise<void> {
  let args: object;
  try {
    args = await argsOf();
  } catch (err) {
    verbs.io.stderr(`error: ${(err as Error).message}\n`);
    return verbs.setExit(EXIT.USAGE);
  }
  const probe = await probeServe(opts.port, verbs.deps.serveWaitMs);
  const health = probe.state === "up" ? probe.health : null;
  const tail = name === "shepherd.status" ? { deploy: deployBlockOf(health), reviewSlots: reviewSlotsOf(health) } : undefined;
  if (health) return verbs.setExit(printShepherd(verbs.io, name, await postRpc(opts.port, name, args), opts, tail));
  if (name === "shepherd.register" && !opts.offline) {
    verbs.io.stderr(`error: ${unansweredMessage(probe, opts.port)}; nothing was recorded (pass --offline to record the run here anyway)\n`);
    return verbs.setExit(EXIT.UNAVAILABLE);
  }
  const envelope = await localEnvelope(verbs, name, args);
  if (name === "shepherd.register" && envelope.ok) verbs.io.stderr(`no titan-factory serve answered on port ${opts.port}, so the run was recorded here; titan-factory serve drives it\n`);
  verbs.setExit(printShepherd(verbs.io, name, envelope, opts, tail));
}

/** A serve built before envelopes carried a code must still fail the shell, never exit 0 on a refusal. */
const exitOf = (code: unknown): number => (Number.isInteger(code) && (code as number) > 0 ? (code as number) : EXIT.FAILURE);

/** What `status` prints after its rows, from serve's `/health`; each block is null when serve answered without it. */
interface StatusTail {
  deploy: DeployHealth | null;
  reviewSlots: ReviewSlots | null;
}

const tailText = (tail: StatusTail | undefined): string => (tail ? `${tail.deploy ? deploySummary(tail.deploy) : ""}${reviewSlotsSummary(tail.reviewSlots)}` : "");

/** `tail` is set for `status` only. */
function printShepherd(io: CliIo, name: ShepherdCommandName, envelope: JsonEnvelope<unknown>, opts: ShepherdOpts, tail: StatusTail | undefined): number {
  if (!envelope.ok) {
    io.stderr(`error: ${envelope.error}\n`);
    return exitOf(envelope.code);
  }
  if (!opts.json) io.stdout(`${formatShepherd(name, statusRows(name, envelope.data, opts), opts)}${tailText(tail)}`);
  else io.stdout(`${JSON.stringify(jsonOf(name, statusRows(name, envelope.data, opts), opts, tail), null, 2)}\n`);
  return name === "shepherd.waiting" && overdueOwnerGates(WaitingSchema.parse(envelope.data)).length > 0 ? EXIT.FAILURE : EXIT.OK;
}

function jsonOf(name: ShepherdCommandName, data: unknown, opts: ShepherdOpts, tail: StatusTail | undefined): unknown {
  if (name === "shepherd.timeline" && opts.last !== undefined) return lastEntries(SHEPHERD_COMMAND_MAP[name].result.parse(data), opts.last).timeline;
  return opts.deploy && tail ? { rows: data, ...tail } : data;
}
