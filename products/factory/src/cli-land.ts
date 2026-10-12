import { probeHealth } from "@titan-design/daemon";
import type { Command } from "commander";
import type { CliIo, Verbs } from "./cli.js";
import { formatGate } from "./cli-host-verbs.js";
import { parsePort } from "./cli-options.js";
import { postRpc } from "./cli-shepherd-rpc.js";
import { EXIT } from "./exit-codes.js";
import { untilSettledOrGated, type FactoryHost } from "./host.js";
import { parsePrRef, startLand, type LandArgs, type LandStarted } from "./registry.js";
import { FACTORY_PORT } from "./serve.js";

export function registerLand(program: Command, verbs: Verbs): void {
  program
    .command("land <ref>")
    .description("land owner/repo#N: hand it to titan-factory serve if one answers, else drive it here until it ends or waits on a human")
    .option("--task <slug/id>", "the task this PR delivers")
    .option("--port <n>", "port titan-factory serve listens on", parsePort, FACTORY_PORT)
    .action((ref: string, opts: { task?: string; port: number }) => landVerb(verbs, ref, opts));
}

async function landVerb(verbs: Verbs, ref: string, opts: { task?: string; port: number }): Promise<void> {
  let args: LandArgs;
  try {
    args = { ...parsePrRef(ref), ...(opts.task ? { task: opts.task } : {}) };
  } catch (err) {
    verbs.io.stderr(`error: ${(err as Error).message}\n`);
    return verbs.setExit(EXIT.USAGE);
  }
  if (await probeHealth(opts.port)) return verbs.setExit(await landOnServer(verbs.io, opts.port, args));
  await verbs.withHost((host) => landInProcess(host, verbs, args, opts.port));
}

/** The server's host starts and owns the run, so this shell can exit while it is still in flight. */
async function landOnServer(io: CliIo, port: number, args: LandArgs): Promise<number> {
  const envelope = await postRpc<LandStarted>(port, "factory.land", args);
  if (!envelope.ok) {
    io.stderr(`error: ${envelope.error}\n`);
    return EXIT.FAILURE;
  }
  io.stdout(`${describeLand(args, envelope.data)} on titan-factory serve (port ${port})\n`);
  return EXIT.OK;
}

async function landInProcess(host: FactoryHost, { io, deps }: Verbs, args: LandArgs, port: number): Promise<number> {
  const started = startLand(host, args);
  if (started.created) await untilSettledOrGated(host.runtime, host.pendingGates, started.runId, deps.host?.gatePollMs ?? 250);
  const run = host.runtime.status(started.runId);
  const lines = [`${describeLand(args, { ...started, status: run?.status ?? started.status })}${run?.error ? ` (${run.error})` : ""}`];
  for (const pending of host.pendingGates().filter((gate) => gate.runId === started.runId)) lines.push(...formatGate(pending));
  if (!started.created) lines.push("titan-factory resume drives an unfinished run");
  lines.push(`no titan-factory serve answered on port ${port}, so this ran in-process; run titan-factory serve to keep it alive`);
  io.stdout(`${lines.join("\n")}\n`);
  return run?.status === "failed" ? EXIT.FAILURE : EXIT.OK;
}

function describeLand(args: LandArgs, started: LandStarted): string {
  return `run ${started.runId} land-pr ${args.repo}#${args.pr}: ${started.status}${started.created ? "" : " (already unfinished)"}`;
}
