import { Command, CommanderError } from "commander";
import {
  EXIT,
  collectCliArgs,
  commandPath,
  invokeCommand,
  optionFlagSpec,
  positionalSpec,
  type AnyCommand,
  type CommandRegistry,
  type JsonEnvelope,
} from "@titan-design/registry";
import { resolveConfig } from "./config.js";
import { createMinerContext, type MinerContext } from "./context.js";
import { MINER_VERSION, createMinerRegistry } from "./registry.js";
import { runMinerMcpStdio, serveMinerUntilSignal } from "./serve.js";

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  env?: NodeJS.ProcessEnv;
}

const defaultIo: CliIo = { stdout: (t) => process.stdout.write(t), stderr: (t) => process.stderr.write(t) };

/** Build the commander program from the registry plus the two long-running entry points. Returns the exit code. */
export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<number> {
  const program = new Command().name("titan-miner").description("Index Claude Code transcripts into a session graph").version(MINER_VERSION);
  program.exitOverride();
  program.option("--json", "emit a JSON envelope on stdout");
  program.option("--state <dir>", "state directory (TITAN_MINER_STATE)");
  program.option("--corpus <dir>", "transcript corpus root (TITAN_MINER_CORPUS)");
  let exitCode: number = EXIT.OK;
  const registry = createMinerRegistry();
  for (const cmd of registry.list()) attach(program, cmd, registry, io, (code) => (exitCode = code));
  attachLongRunning(program, io);
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
  for (const [key, opt] of Object.entries(cmd.cli?.options ?? {})) sub.option(optionFlagSpec(cmd, key, opt), opt.description);
  sub.action(async (...handlerArgs: unknown[]) => {
    const positionals = handlerArgs.slice(0, cmd.cli?.positional?.length ?? 0);
    const opts = handlerArgs[cmd.cli?.positional?.length ?? 0] as Record<string, unknown>;
    const root = program.opts() as { json?: boolean; state?: string; corpus?: string };
    const ctx = createMinerContext(resolveConfig({ stateDir: root.state, corpusRoot: root.corpus }, io.env), root.json ? "json" : "human");
    try {
      const { envelope, exitCode } = await invokeCommand(cmd, collectCliArgs(cmd, positionals, opts), ctx, { invalidArgsCode: EXIT.USAGE });
      emit(io, envelope, ctx.format);
      onExit(exitCode);
    } finally {
      ctx.close();
    }
  });
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
  const config = () => {
    const root = program.opts() as { state?: string; corpus?: string };
    return resolveConfig({ stateDir: root.state, corpusRoot: root.corpus }, io.env);
  };
  program
    .command("serve")
    .description("Run the daemon: /rpc, /mcp, /events on loopback")
    .option("--port <n>", "port (default 7400)")
    .action(async (opts: { port?: string }) => serveMinerUntilSignal(config(), { port: opts.port === undefined ? undefined : Number(opts.port) }));
  program.command("mcp").description("Serve MCP over stdio").action(() => runMinerMcpStdio(config()));
}
