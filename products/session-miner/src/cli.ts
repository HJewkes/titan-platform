import path from "node:path";
import { Command, CommanderError } from "commander";
import {
  EXIT,
  collectCliArgs,
  collectOptionParser,
  commandPath,
  invokeCommand,
  optionFlagSpec,
  positionalSpec,
  type AnyCommand,
  type CommandRegistry,
  type JsonEnvelope,
} from "@titan-design/registry";
import { isObjectLike } from "@titan-design/rpc-protocol/narrow";
import { resolveConfig, type ConfigOverrides, type MinerConfig } from "./config.js";
import { createMinerContext, type MinerContext } from "./context.js";
import { runGraphRefresh, spawnRefresh } from "./graph-refresh.js";
import { MINER_VERSION, createMinerRegistry } from "./registry.js";
import { runMinerMcpStdio, serveMinerUntilSignal } from "./serve.js";
import { DEFAULT_TOOL_ADOPTION_PORTS } from "./insights/tool-adoption.js";
import { DEFAULT_TOOL_GAPS_PORTS } from "./insights/tool-gaps.js";
import { DEFAULT_GAP_THRESHOLD, type GapThreshold } from "./tool-gap-weekly.js";
import { activeWorkCli, notifyCommand, runToolGapWeekly } from "./tool-gap-weekly-run.js";
import { defaultProfilesRoot } from "./friction-transcripts.js";
import { defaultFrictionArchive, parseWindowMs, renderFrictionResult, runFrictionDaily, titanConsoleInbox, type ConsoleInboxPort } from "./friction-daily-run.js";
import { attachReportIntake } from "./report-intake-run.js";
import { DEFAULT_MAX_BUDGET_USD, checkInputs, runSelfImproveDaily, type DailyOptions, type RunnerFor } from "./self-improve/run.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
  /** Where self-improve-daily's model calls go; tests pass a fake so no model is called. */
  runnerFor?: RunnerFor;
  /** Where friction-daily withdraws and files; tests pass a fake so no inbox is touched. */
  consoleInbox?: ConsoleInboxPort;
}

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) };

/** Build the commander program from the registry plus the two long-running entry points. Returns the exit code. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const program = new Command().name("titan-miner").description("Index Claude Code transcripts into a session graph").version(MINER_VERSION);
  program.exitOverride();
  program.option("--json", "emit a JSON envelope on stdout");
  program.option("--state <dir>", "state directory (TITAN_MINER_STATE)");
  program.option("--corpus <dir>", "Claude transcript corpus root (TITAN_MINER_CORPUS)");
  program.option("--codex-home <dir>", "also index Codex sessions and archives (TITAN_MINER_CODEX_HOME)");
  program.option("--namespace <name>", "stable host/account corpus identity (TITAN_MINER_NAMESPACE)");
  program.option("--graph <file>", "read another owner's session graph, read-only, such as active-work's (TITAN_MINER_GRAPH)");
  program.hook("preAction", () => {
    try {
      resolveConfig(configOverrides(program.opts<RootOptions>()), io.env);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.stderr(`error: ${message}\n`);
      throw new CommanderError(EXIT.USAGE, "miner.invalidConfig", message);
    }
  });
  let exitCode: number = EXIT.OK;
  const registry = createMinerRegistry();
  for (const cmd of registry.list()) attach(program, cmd, registry, io, (code) => (exitCode = code));
  attachLongRunning(program, io);
  attachScheduled(program, io, (code) => (exitCode = code));
  try {
    await program.parseAsync(argv, { from: "user" });
  } catch (err) {
    if (err instanceof CommanderError) return err.code === "commander.helpDisplayed" || err.code === "commander.version" ? EXIT.OK : EXIT.USAGE;
    io.stderr(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.SOFTWARE;
  }
  return exitCode;
}

function attach(program: Command, cmd: AnyCommand<MinerContext>, registry: CommandRegistry<MinerContext>, io: CliIo, onExit: (code: number) => void): void {
  const parts = commandPath(cmd.name);
  const parent = ensureGroup(program, parts.slice(0, -1));
  const sub = parent.command(parts[parts.length - 1]!).description(cmd.description);
  for (const name of cmd.cli?.positional ?? []) sub.argument(positionalSpec(cmd, name), name);
  for (const [key, opt] of Object.entries(cmd.cli?.options ?? {})) {
    const parser = collectOptionParser(cmd, key);
    const spec = optionFlagSpec(cmd, key, opt);
    if (parser) sub.option(spec, opt.description, parser);
    else sub.option(spec, opt.description);
  }
  sub.action(async (...handlerArgs: unknown[]) => {
    const positionals = handlerArgs.slice(0, cmd.cli?.positional?.length ?? 0);
    const rawOpts = handlerArgs[cmd.cli?.positional?.length ?? 0];
    const opts = isObjectLike(rawOpts) ? rawOpts : {};
    const root = program.opts<RootOptions & { json?: boolean }>();
    const ctx = createMinerContext(resolveConfig(configOverrides(root), io.env), { format: root.json ? "json" : "human", surface: "cli" });
    try {
      const { envelope, exitCode } = await invokeCommand(cmd, collectCliArgs(cmd, positionals, opts), ctx, { invalidArgsCode: EXIT.USAGE });
      emit(io, envelope, ctx.format);
      onExit(exitCode);
    } finally {
      ctx.close();
    }
  });
}

interface RootOptions {
  state?: string;
  corpus?: string;
  codexHome?: string;
  namespace?: string;
  graph?: string;
}

function configOverrides(root: RootOptions): ConfigOverrides {
  return { stateDir: root.state, corpusRoot: root.corpus, codexHome: root.codexHome, namespace: root.namespace, graph: root.graph };
}

function ensureGroup(root: Command, parts: string[]): Command {
  let current = root;
  for (const part of parts) current = current.commands.find((c) => c.name() === part) ?? current.command(part).description(`${part} commands`);
  return current;
}

function emit(io: CliIo, envelope: JsonEnvelope<unknown>, format: "human" | "json"): void {
  if (format === "json") return io.stdout(`${JSON.stringify(envelope)}\n`);
  if (!envelope.ok) return io.stderr(`error: ${envelope.error}\n`);
  for (const w of envelope.warnings ?? []) io.stderr(`warning: ${w}\n`);
  io.stdout(typeof envelope.data === "string" ? `${envelope.data}\n` : `${JSON.stringify(envelope.data, null, 2)}\n`);
}

function attachLongRunning(program: Command, io: CliIo): void {
  const config = () => resolveConfig(configOverrides(program.opts<RootOptions>()), io.env);
  program
    .command("serve")
    .description("Run the daemon: /rpc, /mcp, /events on loopback")
    .option("--port <n>", "port (default 7400)")
    .action(async (opts: { port?: string }) => serveMinerUntilSignal(config(), { port: opts.port === undefined ? undefined : Number(opts.port) }));
  program.command("mcp").description("Serve MCP over stdio").action(() => runMinerMcpStdio(config()));
}

function attachGraphRefresh(program: Command, io: CliIo, onExit: (code: number) => void): void {
  program
    .command("graph-refresh")
    .description("Scheduled refresh: run the graph owner's refresh under a lock, then quick_check the graph")
    .argument("<refresh...>", "the owner's refresh command, after --")
    .option("--lock <file>", "lock file (default <state>/graph-refresh.lock)")
    .action(async (argv: string[], opts: { lock?: string }) => {
      const root = program.opts<RootOptions>();
      // An unset variable in a unit's `--graph "${VAR}"` arrives empty, which would otherwise check the miner's own index.
      if (root.graph === "") {
        io.stderr("error: --graph is empty\n");
        return onExit(EXIT.USAGE);
      }
      const resolved = resolveConfig(configOverrides(root), io.env);
      const result = await runGraphRefresh({
        dbPath: resolved.dbPath,
        lockPath: opts.lock ?? path.join(resolved.stateDir, "graph-refresh.lock"),
        refresh: spawnRefresh(argv),
        log: (line) => io.stderr(`${line}\n`),
      });
      io.stdout(`${JSON.stringify(result)}\n`);
      onExit(result.exitCode);
    });
}

interface ToolGapWeeklyFlags {
  initiative: string;
  minCalls: string;
  minSessions: string;
  notifyCommand: string;
}

/** The verbs systemd timers run; CLI-only, since they spawn processes and hold locks. */
function attachScheduled(program: Command, io: CliIo, onExit: (code: number) => void): void {
  attachGraphRefresh(program, io, onExit);
  attachToolGapWeekly(program, io, onExit);
  attachSelfImproveDaily(program, io, onExit);
  attachFrictionDaily(program, io, onExit);
  attachReportIntake(program, () => resolveConfig(configOverrides(program.opts()), io.env), io, onExit);
}

interface FrictionDailyFlags {
  since: string;
  dryRun?: boolean;
  archiveDir?: string;
  profiles?: string;
}

function attachFrictionDaily(program: Command, io: CliIo, onExit: (code: number) => void): void {
  program
    .command("friction-daily")
    .description("Daily pass: rank the window's friction from worker transcripts, then from worker reports, archive the rows, file one owner inbox item")
    .option("--since <window>", "how far back to read, as <n>h or <n>d", "24h")
    .option("--dry-run", "print the top clusters; write and file nothing")
    .option("--archive-dir <dir>", "where <date>.jsonl and <date>.md go (default <active-work>/titan-platform/artifacts/friction-daily)")
    .option("--profiles <dir>", "root of the Claude profiles whose <profile>/projects transcripts are read (default ~/.claude-profiles)")
    .action(async (opts: FrictionDailyFlags) => {
      const windowMs = parseWindowMs(opts.since);
      if (windowMs === null) {
        io.stderr("error: --since takes <n>h or <n>d\n");
        return onExit(EXIT.USAGE);
      }
      const config = resolveConfig(configOverrides(program.opts()), io.env);
      const result = await runFrictionDaily({
        eventsDb: config.eventsDb,
        profilesRoot: opts.profiles ?? defaultProfilesRoot(),
        archiveDir: opts.archiveDir ?? defaultFrictionArchive(config.initiativesRoot),
        now: new Date(),
        windowMs,
        dryRun: opts.dryRun === true,
        inbox: io.consoleInbox ?? titanConsoleInbox,
      });
      io.stdout(program.opts().json === true ? `${JSON.stringify(result)}\n` : renderFrictionResult(result));
      onExit(EXIT.OK);
    });
}

function attachToolGapWeekly(program: Command, io: CliIo, onExit: (code: number) => void): void {
  program
    .command("tool-gap-weekly")
    .description("Scheduled pass: run Q9 and Q10 over the last 7 days, file or note one tool-gap task per pattern, send one digest")
    .requiredOption("--notify-command <path>", "command that receives the digest on stdin")
    .option("--initiative <slug>", "active-work initiative the tasks go to", "titan-platform")
    .option("--min-calls <n>", "calls a pattern needs before it gets a task", String(DEFAULT_GAP_THRESHOLD.minCalls))
    .option("--min-sessions <n>", "sessions a pattern needs before it gets a task", String(DEFAULT_GAP_THRESHOLD.minSessions))
    .action(async (opts: ToolGapWeeklyFlags) => {
      const threshold = { minCalls: Number(opts.minCalls), minSessions: Number(opts.minSessions) };
      if (!Number.isInteger(threshold.minCalls) || !Number.isInteger(threshold.minSessions)) {
        io.stderr("error: --min-calls and --min-sessions take whole numbers\n");
        return onExit(EXIT.USAGE);
      }
      onExit(await toolGapWeeklyFromCli(resolveConfig(configOverrides(program.opts()), io.env), opts, threshold, io));
    });
}

async function toolGapWeeklyFromCli(config: MinerConfig, opts: ToolGapWeeklyFlags, threshold: GapThreshold, io: CliIo): Promise<number> {
  const ctx = createMinerContext(config, { format: "json", surface: "cli" });
  try {
    const result = await runToolGapWeekly({
      db: ctx.graph().db,
      dir: path.join(config.stateDir, "tool-gap-weekly"),
      initiative: opts.initiative,
      threshold,
      reports: { ...DEFAULT_TOOL_GAPS_PORTS, ...DEFAULT_TOOL_ADOPTION_PORTS },
      activeWork: activeWorkCli,
      notify: notifyCommand(opts.notifyCommand),
      log: (line) => io.stderr(`${line}\n`),
    });
    io.stdout(`${JSON.stringify(result)}\n`);
    return result.exitCode;
  } finally {
    ctx.close();
  }
}

interface SelfImproveDailyFlags {
  chunks: string;
  prompts: string;
  out: string;
  maxBudgetUsd: string;
}

function attachSelfImproveDaily(program: Command, io: CliIo, onExit: (code: number) => void): void {
  program
    .command("self-improve-daily")
    .description("Classify the self-improve chunk files as one resumable workflow run under a run budget")
    .requiredOption("--chunks <dir>", "dir of <family>_<n>.txt chunk files")
    .requiredOption("--prompts <dir>", "dir of <family>.md prompts; they stay outside this repo")
    .requiredOption("--out <dir>", "where <family>.jsonl and summary.json are written")
    .option("--max-budget-usd <n>", "what the whole run may spend", String(DEFAULT_MAX_BUDGET_USD))
    .action(async (opts: SelfImproveDailyFlags) => {
      const options: DailyOptions = { chunks: opts.chunks, prompts: opts.prompts, out: opts.out, maxBudgetUsd: Number(opts.maxBudgetUsd) };
      const invalid = options.maxBudgetUsd > 0 ? checkInputs(options) : "--max-budget-usd takes a positive number";
      if (invalid) {
        io.stderr(`error: ${invalid}\n`);
        return onExit(EXIT.USAGE);
      }
      onExit(await selfImproveDailyFromCli(resolveConfig(configOverrides(program.opts()), io.env), options, io));
    });
}

/** Ctrl-C releases the run's lease on the way out, so a rerun resumes at once instead of waiting it out. */
async function selfImproveDailyFromCli(config: MinerConfig, options: DailyOptions, io: CliIo): Promise<number> {
  const interrupt = new AbortController();
  const stop = () => interrupt.abort();
  process.once("SIGINT", stop).once("SIGTERM", stop);
  try {
    const stateDir = path.join(config.stateDir, "self-improve-daily");
    const result = await runSelfImproveDaily(options, { stateDir, signal: interrupt.signal, ...(io.runnerFor ? { runnerFor: io.runnerFor } : {}) });
    io.stdout(`${JSON.stringify(result)}\n`);
    return result.status === "completed" ? EXIT.OK : EXIT.SOFTWARE;
  } finally {
    process.off("SIGINT", stop).off("SIGTERM", stop);
  }
}
