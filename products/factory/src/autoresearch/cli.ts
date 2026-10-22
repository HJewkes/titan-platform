import { existsSync, readFileSync } from "node:fs";
import { AUTORESEARCH_WORKFLOW, type ArRunSummary, type ArRunView } from "@titan-design/autoresearch";
import { EXIT as RPC_EXIT, inProcessCaller, type JsonEnvelope } from "@titan-design/registry";
import { InvalidArgumentError, type Command } from "commander";
import { z } from "zod";
import type { Verbs } from "../cli.js";
import { formatResume } from "../cli-host-verbs.js";
import { parsePort } from "../cli-options.js";
import { postRpc, unansweredMessage } from "../cli-shepherd-rpc.js";
import { EXIT } from "../exit-codes.js";
import { untilSettledOrGated, type FactoryHost } from "../host.js";
import { createFactoryRegistry, factoryContext } from "../registry.js";
import { FACTORY_PORT } from "../serve.js";
import { probeServe } from "../serve-probe.js";

const RUNGS = ["none", "L0", "L1", "L2", "L3"] as const;

/** The answers this group prints; the read models are the commands' own types, which serve and in-process share. */
const Started = z.object({ runId: z.string(), status: z.string() });
const LookStarted = z.object({ runId: z.string(), look: z.number(), head: z.string() });
const Summaries = z.custom<ArRunSummary[]>(Array.isArray);
const View = z.custom<ArRunView>((value) => typeof value === "object" && value !== null && "rounds" in value);

type Where = { at: "serve" } | { at: "local" } | { at: "unavailable"; reason: string };

/**
 * Serve when it answers. Otherwise in-process, unless the verb needs serve or a read would find no database: a
 * read never creates one, and a busy or unready serve is never raced by a second host on its database.
 */
async function whereTo(verbs: Verbs, port: number, need: { serve?: string; db?: boolean }): Promise<Where> {
  const probe = await probeServe(port, verbs.deps.serveWaitMs);
  if (probe.state === "up") return { at: "serve" };
  if (probe.state !== "refused") return { at: "unavailable", reason: unansweredMessage(probe, port) };
  if (need.serve) return { at: "unavailable", reason: `${need.serve}; ${unansweredMessage(probe, port)}` };
  if (need.db && !existsSync(verbs.dbPath())) return { at: "unavailable", reason: `${unansweredMessage(probe, port)}, and there is no local database at ${verbs.dbPath()}` };
  return { at: "local" };
}

/** `after` runs on the same host before it closes, so a run started here can be driven here. */
type After = (data: unknown, host: FactoryHost) => Promise<void>;

async function inProcess(verbs: Verbs, name: string, args: object, after?: After): Promise<JsonEnvelope<unknown>> {
  let envelope: JsonEnvelope<unknown> = { ok: false, error: `${name} did not run`, code: RPC_EXIT.SOFTWARE };
  await verbs.withHost(async (host, routes) => {
    envelope = await inProcessCaller(createFactoryRegistry(), () => factoryContext(host, routes))(name, args);
    if (envelope.ok && after) await after(envelope.data, host);
    return EXIT.OK;
  });
  return envelope;
}

/** Answers the command's data, or undefined after setting the exit code: bad arguments are usage, any other refusal a failure. */
async function call(verbs: Verbs, port: number, name: string, args: object, need: { serve?: string; db?: boolean } = {}, after?: After): Promise<unknown> {
  const where = await whereTo(verbs, port, need);
  if (where.at === "unavailable") return void (verbs.io.stderr(`error: ${where.reason}\n`), verbs.setExit(EXIT.UNAVAILABLE));
  const envelope = where.at === "serve" ? await postRpc<unknown>(port, name, args) : await inProcess(verbs, name, args, after);
  if (envelope.ok) return envelope.data;
  verbs.io.stderr(`error: ${envelope.error}\n`);
  verbs.setExit(envelope.code === RPC_EXIT.USAGE ? EXIT.USAGE : EXIT.FAILURE);
  return undefined;
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new InvalidArgumentError("expected a positive integer");
  return parsed;
}

const usage = (verbs: Verbs, message: string) => (verbs.io.stderr(`error: ${message}\n`), verbs.setExit(EXIT.USAGE));
const short = (sha: string) => sha.slice(0, 12);

/** One line per rung from none to L3, each naming the ideas whose ladder stopped there; ladders still running are listed apart. */
function formatRungs(view: ArRunView): string[] {
  const ladders = view.rounds.flatMap((round) => round.ladders);
  const at = (rung: string) => ladders.filter((ladder) => ladder.outcome?.rungReached === rung).map((ladder) => ladder.idea.id);
  const running = ladders.filter((ladder) => ladder.outcome === null).map((ladder) => ladder.idea.id);
  const lines = RUNGS.map((rung) => `  ${rung}: ${at(rung).join(" ") || "-"}`);
  return running.length > 0 ? [...lines, `  running: ${running.join(" ")}`] : lines;
}

export function formatView(view: ArRunView): string {
  const round = view.rounds.at(-1)?.round ?? 0;
  const head = `run ${view.runId} ${view.target.name}: ${view.status}, round ${round}/${view.settings.rounds}, best ${short(view.best.head)} ${view.target.metric.primary} ${view.best.primary}`;
  const tail = [...(view.stopReason ? [`  stopped: ${view.stopReason}`] : []), ...(view.error ? [`  error: ${view.error}`] : [])];
  return `${[head, ...formatRungs(view), ...tail].join("\n")}\n`;
}

function formatSummaries(runs: readonly ArRunSummary[]): string {
  if (runs.length === 0) return "no autoresearch runs\n";
  const line = (run: ArRunSummary) =>
    `${run.runId} ${run.target} ${run.phase || "-"}: ${run.status}, round ${run.round}/${run.rounds}, best ${run.best ? `${short(run.best.head)} ${run.best.primary}` : "-"}, $${run.spend.toFixed(2)}`;
  return `${runs.map(line).join("\n")}\n`;
}

/** With no serve, the run is driven here until it ends or waits on a human, as `land` does. */
async function startVerb(verbs: Verbs, target: string, opts: { pin: string; lanes?: number; rounds?: number; port: number }): Promise<void> {
  const config = { ...(opts.lanes ? { lanes: opts.lanes } : {}), ...(opts.rounds ? { rounds: opts.rounds } : {}) };
  let ended: { status: string; error: string | null } | undefined;
  const drive: After = async (data, host) => {
    const { runId } = Started.parse(data);
    await untilSettledOrGated(host.runtime, host.pendingGates, runId, verbs.deps.host?.gatePollMs ?? 250);
    const run = host.runtime.status(runId);
    ended = { status: run?.status ?? "unknown", error: run?.error ?? null };
  };
  const answer = await call(verbs, opts.port, "autoresearch.start", { target, pin: opts.pin, config }, {}, drive);
  if (answer === undefined) return;
  const started = Started.parse(answer);
  if (ended === undefined) return verbs.io.stdout(`run ${started.runId} autoresearch ${target}: ${started.status} on titan-factory serve (port ${opts.port})\n`);
  const detail = ended.error ? ` (${ended.error})` : "";
  verbs.io.stdout(`run ${started.runId} autoresearch ${target}: ${ended.status}${detail}\nno titan-factory serve answered on port ${opts.port}, so this ran in-process; run titan-factory serve to keep it alive\n`);
  if (ended.status === "failed") verbs.setExit(EXIT.FAILURE);
}

function registerStart(group: Command, verbs: Verbs): void {
  group
    .command("start <target>")
    .description("start a run on a configured target at a pinned commit on its default branch; refused while the target has an unfinished run")
    .requiredOption("--pin <sha>", "the commit the run evaluates against and ratchets from")
    .option("--lanes <n>", "ideas built in parallel per round", positiveInt)
    .option("--rounds <n>", "the most rounds the run takes", positiveInt)
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action((target: string, opts: { pin: string; lanes?: number; rounds?: number; port: number }) => startVerb(verbs, target, opts));
}

function registerResume(group: Command, verbs: Verbs): void {
  group
    .command("resume <runId>")
    .description("drive an unfinished autoresearch run in this process until it ends or waits on a human")
    .action((runId: string) =>
      verbs.withHost(async (host) => {
        if (host.runtime.status(runId)?.workflowName !== AUTORESEARCH_WORKFLOW) return (verbs.io.stderr(`error: [not_found] no autoresearch run ${runId}\n`), EXIT.FAILURE);
        verbs.io.stdout(formatResume(await host.resume()));
        return EXIT.OK;
      }),
    );
}

function registerStatus(group: Command, verbs: Verbs): void {
  group
    .command("status [runId]")
    .description("every autoresearch run, or one run with the ideas stopped at each rung")
    .option("--json", "print the read model as JSON")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action(async (runId: string | undefined, opts: { json?: boolean; port: number }) => {
      const [name, args] = runId === undefined ? ["autoresearch.runs", {}] : ["autoresearch.run", { runId }];
      const data = await call(verbs, opts.port, name, args, { db: true });
      if (data === undefined) return;
      if (opts.json) return verbs.io.stdout(`${JSON.stringify(data, null, 2)}\n`);
      verbs.io.stdout(runId === undefined ? formatSummaries(Summaries.parse(data)) : formatView(View.parse(data)));
    });
}

function readProposal(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function registerAddIdea(group: Command, verbs: Verbs): void {
  group
    .command("add-idea <runId>")
    .description("queue an owner proposal (a JSON file) for an unfinished run's next round")
    .requiredOption("--file <proposal.json>", "the proposal, in the planner's proposal shape")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action(async (runId: string, opts: { file: string; port: number }) => {
      let proposal: unknown;
      try {
        proposal = readProposal(opts.file);
      } catch (error) {
        return usage(verbs, `cannot read ${opts.file} as JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
      const added = await call(verbs, opts.port, "autoresearch.add-idea", { runId, proposal });
      if (added !== undefined) verbs.io.stdout(`queued an owner idea for run ${runId}; it is read at the next round\n`);
    });
}

function registerMilestone(group: Command, verbs: Verbs): void {
  group
    .command("milestone <runId>")
    .description("start one validator look at the run's best head on held-out cases; needs titan-factory serve")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action(async (runId: string, opts: { port: number }) => {
      const need = { serve: "milestone counts looks and starts one in a single turn, which only serve can do without racing another process" };
      const answer = await call(verbs, opts.port, "autoresearch.milestone", { runId }, need);
      if (answer === undefined) return;
      const look = LookStarted.parse(answer);
      verbs.io.stdout(`look ${look.look} at ${short(look.head)}: run ${look.runId}\n`);
    });
}

/** `titan-factory autoresearch`: every verb goes to serve when it answers, and only the reads and writes that are safe here fall back in-process. */
export function registerAutoresearch(program: Command, verbs: Verbs): void {
  const group = program.command("autoresearch").description("start, watch, steer and validate autoresearch runs");
  for (const register of [registerStart, registerResume, registerStatus, registerAddIdea, registerMilestone]) register(group, verbs);
}
