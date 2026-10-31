import { resolve } from "node:path";
import type { JsonEnvelope } from "@titan-design/registry";
import type { Command } from "commander";
import type { CliIo, Verbs } from "./cli.js";
import { refusedInProcess } from "./cli-agent-env.js";
import { deployCheckoutFor } from "./cli-service.js";
import { registerShepherdCoverage } from "./cli-coverage.js";
import { registerOwnerRelease } from "./cli-owner-release.js";
import { callerOf, parsePort, parsePositiveInt, parseTarget, statusArgs, statusRows, withStatusFilters, type StatusFilter } from "./cli-options.js";
import { localEnvelope, postRpc, unansweredMessage } from "./cli-shepherd-rpc.js";
import { registerShepherdPlanRound } from "./cli-shepherd-plan-round.js";
import { registerShepherdWait } from "./cli-shepherd-wait.js";
import { registerShepherdWatch } from "./cli-shepherd-watch.js";
import { registerShepherdStats } from "./cli-stats.js";
import { gitBehind } from "./deploy-behind.js";
import { deployBlockOf, deploySummary, withGitBehind, type DeployHealth } from "./deploy-health.js";
import { EXIT } from "./exit-codes.js";
import { parsePayload } from "./gate-resolve.js";
import { parsePrRef } from "./registry.js";
import { FACTORY_PORT } from "./serve.js";
import { reviewSlotsOf, reviewSlotsSummary } from "./review-slots-health.js";
import { probeServe } from "./serve-probe.js";
import { activeWorkOrigin } from "./shepherd/cleanup-ports.js";
import { SHEPHERD_COMMAND_MAP, type ShepherdCommandName } from "./shepherd/commands.js";
import { formatShepherd, lastEntries, type TimelineView } from "./shepherd/format.js";
import { writesPort } from "./shepherd/port-access.js";
import { inferIdentity } from "./shepherd/register-identity.js";
import { qualifyTask } from "./shepherd/task-ref.js";
import type { ReviewSlots } from "./shepherd/review-slots.js";
import { overdueOwnerGates, WaitingSchema } from "./shepherd/waiting.js";
import { errorMessage } from "./narrow.js";

interface ShepherdOpts extends TimelineView, StatusFilter {
  port: number;
  json?: boolean;
  offline?: boolean;
  deploy?: boolean;
}

type SliceOpts = { slice?: string | false; lastSlice?: true };
type RegisterOpts = ShepherdOpts & SliceOpts & { branch?: string; head?: string; base?: string; task?: string; implementer?: string; reviewer?: string; kind?: string; policy?: string };

/** The shepherd.* registry commands as verbs: on titan-factory serve when one answers, else against the database here; register needs --offline for that. */
export function registerShepherd(program: Command, verbs: Verbs): void {
  const shepherd = program.command("shepherd").description("shepherd PRs to a merge; gate resolve and owner-release stay local verbs and are never shepherd commands");
  const verb: VerbOf = (spec, description) =>
    shepherd
      .command(spec)
      .description(description)
      .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
      .option("--json", "print the result as JSON");
  registerRunVerbs(verb, verbs);
  registerHoldVerbs(verb, verbs);
  registerRepairStopVerbs(verb, verbs);
  registerMergeBaseVerbs(verb, verbs);
  registerRepoFreezeVerbs(verb, verbs);
  registerOrderVerbs(verb, verbs);
  registerShepherdStats(shepherd, verbs.io, verbs.dbPath, verbs.setExit);
  registerShepherdCoverage(shepherd, verbs.io, verbs.dbPath, verbs.setExit);
  registerShepherdWait(shepherd, verbs);
  registerShepherdWatch(verb, verbs, runShepherd);
  registerOwnerRelease(shepherd, verbs);
  registerShepherdPlanRound(shepherd, verbs);
  registerRefVerbs(verb, verbs);
}

type VerbOf = (spec: string, description: string) => Command;

function registerRunVerbs(verb: VerbOf, verbs: Verbs): void {
  verb("register <target>", "shepherd owner/repo#N, or owner/repo with --branch before its PR exists; a repeat returns the existing run, or a new one if it failed, or was cancelled with its PR open")
    .option("--branch <name>", "the PR's head branch")
    .option("--head <sha>", "the PR's head commit; with --branch, Shepherd does not read the PR from GitHub to register it")
    .option("--base <name>", "the PR's base branch; with --head, Shepherd classes the PR's files from local git")
    .option("--task <slug/id>", "the task this PR delivers; defaults to the id in an agent-chat/<name> head branch")
    .option("--implementer <name>", "the agent that pushes fixes; defaults to <name> of an agent-chat/<name> head branch")
    .option("--reviewer <name>", "the agent that reviews")
    .option("--kind <kind>", "correctness, security, feature, refactor, test-only (the PR changes only tests) or unknown")
    .option("--slice <label>", "this PR is one slice of a multi-slice task: landing notes the task instead of closing it")
    .option("--no-slice", "clear a slice kept from an earlier registration")
    .option("--last-slice", "this PR is its task's last slice, as a 'Last slice: yes' body line says; under taskClose last-slice-only its merge closes the task")
    .option("--policy <json>", 'narrow the seat policy, e.g. {"merge":"never"}')
    .option("--offline", "record the run in the database here when no titan-factory serve answers; nothing drives it until serve starts")
    .action((target: string, opts: RegisterOpts) => runShepherd(verbs, "shepherd.register", () => registerArgs(target, opts, verbs), opts));
  withStatusFilters(verb("status [target]", "one line per shepherded PR, optionally only owner/repo or owner/repo#N, then serve's deploy and reviewer-slot lines"))
    .option("--deploy", "with --json, print { rows, deploy, reviewSlots } so serve's deploy block and reviewer-slot reading ride along; without it --json stays the bare row array")
    .action((target: string | undefined, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.status", () => statusArgs(target ? parseTarget(target) : undefined, opts), opts));
  verb("list", "the watch list")
    .option("--state <state>", "active, finished or all", "active")
    .action((opts: ShepherdOpts & { state: string }) => runShepherd(verbs, "shepherd.list", () => ({ state: opts.state }), opts));
  verb("prs [repo]", "every open PR of each seat repo, or of owner/repo, from Shepherd's snapshot, plus the PRs it merged in the last 24 h")
    .action((repo: string | undefined, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.prs", () => (repo ? { repo } : {}), opts));
  verb("waiting", "every pending gate, oldest first: what waits on the owner, then seat work (ci-failed, sh-sent-back, stuck-behind)")
    .action((opts: ShepherdOpts) => runShepherd(verbs, "shepherd.waiting", () => ({}), opts));
  registerVisualDeltaVerb(verb, verbs);
  registerBriefVerb(verb, verbs);
}

/** TP-1696: the owner PR section for one PR, printed. Reads GitHub, Shepherd and active-work; writes nothing. */
function registerBriefVerb(verb: VerbOf, verbs: Verbs): void {
  verb("brief <ref>", "print the owner PR section for owner/repo#N as markdown, or as the review harness's round-section JSON; read-only")
    .option("--format <format>", "md or round-section", "md")
    .option("--images <dir>", "a directory holding pr-<n>/manifest.json, for the before and after pairs of a UI PR")
    .action((ref: string, opts: ShepherdOpts & { format: string; images?: string }) =>
      runShepherd(verbs, "shepherd.brief", () => ({ ...parsePrRef(ref), format: opts.format, ...(opts.images !== undefined && { images: resolve(opts.images) }) }), opts));
}

/** TP-4320's calibration read: the delta the evidence step would measure, before a repo's threshold goes `on`. */
function registerVisualDeltaVerb(verb: VerbOf, verbs: Verbs): void {
  verb("visual-delta", "print as JSON the visual delta the merge evidence step would measure for --repo's PR --pr under its shepherd.visualThreshold, with a count of shots the decoder refused as an unsupported format; read-only, no step and no record")
    .requiredOption("--repo <owner/repo>", "the PR's repo")
    .requiredOption("--pr <n>", "the PR number", parsePositiveInt)
    .option("--head <sha>", "the 40-character head to measure; when the PR is no longer at it, its files read as unread and nothing is measured")
    .action((opts: ShepherdOpts & { repo: string; pr: number; head?: string }) => runShepherd(verbs, "shepherd.visual-delta", () => ({ repo: opts.repo, pr: opts.pr, head: opts.head }), opts));
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

/** A repair stop is the seat's stop on fixers short of an owner hold; it is not a hold, so these verbs never touch the release path. */
function registerRepairStopVerbs(verb: VerbOf, verbs: Verbs): void {
  verb("repair-stop <ref>", "stop every fixer wake and resume for owner/repo#N, or for each PR touching owner/repo:<path glob>; a stop is not a hold and leaves the release path as it is")
    .requiredOption("--reason <text>", "why fixers are stopped")
    .action((ref: string, opts: ShepherdOpts & { reason: string }) =>
      runShepherd(verbs, "shepherd.repair-stop", () => ({ action: "set", ref, reason: opts.reason, actor: callerOf(verbs.io.env) }), opts));
  verb("repair-go <ref>", "clear the repair stop on owner/repo#N or owner/repo:<path glob>, so the next wake repairs as before")
    .action((ref: string, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.repair-stop", () => ({ action: "clear", ref, actor: callerOf(verbs.io.env) }), opts));
  verb("repair-stops [repo]", "every repair stop, or only owner/repo's")
    .action((repo: string | undefined, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.repair-stop", () => ({ action: "list", ...(repo && { repo }) }), opts));
}

/** A planner's leave for a run's fix rounds to merge the base, when the fix needs code that landed there (TP-4242). */
function registerMergeBaseVerbs(verb: VerbOf, verbs: Verbs): void {
  verb("allow-merge-base <ref>", "let owner/repo#N's fix rounds merge the base branch: their briefs name who allowed it and why in place of the line that forbids it; a repeat replaces the reason")
    .requiredOption("--reason <text>", "why the fix needs the base, e.g. the PR on main it depends on")
    .action((ref: string, opts: ShepherdOpts & { reason: string }) =>
      runShepherd(verbs, "shepherd.merge-base", () => ({ action: "allow", ...parsePrRef(ref), reason: opts.reason, actor: callerOf(verbs.io.env) }), opts));
  verb("revoke-merge-base <ref>", "drop owner/repo#N's merge-base exception, so its fix rounds are told not to merge the base again")
    .action((ref: string, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.merge-base", () => ({ action: "revoke", ...parsePrRef(ref) }), opts));
}

/** A coordinator's pause on a whole repo's merges, apart from the main-red freeze, which only `thaw` lifts by hand. */
function registerRepoFreezeVerbs(verb: VerbOf, verbs: Verbs): void {
  verb("freeze <repo>", "freeze owner/repo so no Shepherd run merges into it until unfreeze; runs keep reviewing, and a repeat replaces the reason")
    .requiredOption("--reason <text>", "why the repo is frozen")
    .action((repo: string, opts: ShepherdOpts & { reason: string }) =>
      runShepherd(verbs, "shepherd.freeze", () => ({ action: "freeze", repo, reason: opts.reason, actor: callerOf(verbs.io.env) }), opts));
  verb("unfreeze <repo>", "lift the freeze on owner/repo, so waiting runs merge on their next step; a red main's freeze stays")
    .action((repo: string, opts: ShepherdOpts) => runShepherd(verbs, "shepherd.freeze", () => ({ action: "unfreeze", repo }), opts));
  verb("freezes", "every repo freeze: repo, reason, who set it and since when; then each open red-main episode with its red sha, fix task, fixer and fix PR")
    .action((opts: ShepherdOpts) => runShepherd(verbs, "shepherd.freeze", () => ({ action: "list" }), opts));
  verb("thaw <repo>", "thaw owner/repo's red-main freeze by hand while it is still red at --red-sha; records who and why, and alerts the repo's red seat")
    .requiredOption("--red-sha <sha>", "the full red sha of the episode being thawed")
    .requiredOption("--reason <text>", "why main may thaw without a green")
    .action((repo: string, opts: ShepherdOpts & { redSha: string; reason: string }) =>
      runShepherd(verbs, "shepherd.thaw", () => ({ repo, redSha: opts.redSha, reason: opts.reason, actor: callerOf(verbs.io.env) }), opts));
  verb("fix-pr <repo> <pr>", "mark registered PR <pr> as the fix of owner/repo's open red-main freeze, so its merge passes the freeze while other PRs stay held; records who marked it")
    .option("--episode <n>", "the red-main episode the mark is for; refused when it is not the open one", parsePositiveInt)
    .action((repo: string, pr: string, opts: ShepherdOpts & { episode?: number }) =>
      runShepherd(verbs, "shepherd.fix-pr", () => ({ repo, pr: parsePositiveInt(pr), episode: opts.episode, actor: callerOf(verbs.io.env) }), opts));
}

/** A conflicted PR's merge-order reservation, read, and ended by hand only as break-glass. */
function registerOrderVerbs(verb: VerbOf, verbs: Verbs): void {
  verb("order [repo] [ref]", "every merge-order reservation, or only owner/repo's; `order clear owner/repo#N --reason <text>` ends one by hand, logged with the caller")
    .option("--reason <text>", "with clear: why the reservation is ended by hand")
    .action((what: string | undefined, ref: string | undefined, opts: ShepherdOpts & { reason?: string }) =>
      runShepherd(verbs, "shepherd.order", () => orderArgs(what, ref, opts.reason, verbs), opts));
}

/** `order clear <ref>` is the break-glass write; any other first word is the repo to list. */
function orderArgs(what: string | undefined, ref: string | undefined, reason: string | undefined, verbs: Verbs): object {
  if (what !== "clear") return what === undefined ? { action: "list" } : { action: "list", repo: what };
  if (ref === undefined) throw new Error("order clear needs owner/repo#N");
  return { action: "clear", ...parsePrRef(ref), reason, actor: callerOf(verbs.io.env) };
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
  const { branch, head, base, reviewer, kind, slice, lastSlice } = opts;
  const parsed = parseTarget(target);
  const { task: given, implementer } = await inferIdentity(parsed, opts, deps.headRef);
  const task = await qualifyTask(given, { origin: activeWorkOrigin(io.env), ...(deps.fetch && { fetch: deps.fetch }) });
  // Not `callerOf`: only an agent-chat name can be messaged, so a terminal registration records no registrant.
  const registrant = io.env.AGENT_CHAT_NAME || undefined;
  return { ...parsed, branch, head, base, task, implementer, registrant, reviewer, kind, slice: slice === false ? undefined : slice, noSlice: slice === false ? true : undefined, lastSlice, policy };
}

async function runShepherd(verbs: Verbs, name: ShepherdCommandName, argsOf: () => object | Promise<object>, opts: ShepherdOpts): Promise<void> {
  let args: object;
  try {
    args = await argsOf();
  } catch (err) {
    verbs.io.stderr(`error: ${errorMessage(err)}\n`);
    return verbs.setExit(EXIT.USAGE);
  }
  const probe = await probeServe(opts.port, verbs.deps.serveWaitMs);
  const health = probe.state === "up" ? probe.health : null;
  const tail = name === "shepherd.status" ? { deploy: await checkedDeploy(verbs, deployBlockOf(health)), reviewSlots: reviewSlotsOf(health) } : undefined;
  if (health) return verbs.setExit(printShepherd(verbs.io, name, await postRpc(opts.port, name, args), opts, tail));
  if (name === "shepherd.register" && !opts.offline) {
    verbs.io.stderr(`error: ${unansweredMessage(probe, opts.port)}; nothing was recorded (pass --offline to record the run here anyway)\n`);
    return verbs.setExit(EXIT.UNAVAILABLE);
  }
  if (writesPort(name, args) && refusedInProcess(verbs, probe, opts.port, name.replace("shepherd.", "shepherd "))) return;
  const envelope = await localEnvelope(verbs, name, args);
  if (name === "shepherd.register" && envelope.ok) verbs.io.stderr(`no titan-factory serve answered on port ${opts.port}, so the run was recorded here; titan-factory serve drives it\n`);
  verbs.setExit(printShepherd(verbs.io, name, envelope, opts, tail));
}

/** A block without `originLag` counts only asked deploys; git says how far main has really moved, and an unreadable git alarms. Serve's own reading is not counted twice. */
async function checkedDeploy(verbs: Verbs, block: DeployHealth | null): Promise<DeployHealth | null> {
  if (block === null || block.originLag !== undefined) return block;
  const probe = verbs.deps.deployBehind ?? gitBehind(deployCheckoutFor(verbs.io.env));
  return withGitBehind(block, await probe(block.runningSha), Date.now());
}

/** A serve built before envelopes carried a code must still fail the shell, never exit 0 on a refusal. */
const exitOf = (code: unknown): number => (typeof code === "number" && Number.isInteger(code) && code > 0 ? code : EXIT.FAILURE);

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
