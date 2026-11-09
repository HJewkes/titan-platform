import { Command, InvalidArgumentError } from 'commander';
import { registry } from './registry/index.js';
import './commands/index.js'; // populates the registry via side effect
import { getActiveRoot } from './utils/paths.js';
import { formatError, EXIT } from './errors.js';
import { agentCaller } from './commands/_done-when-gate.js';
import {
  successEnvelope,
  errorEnvelope,
  type AnyCommand,
  type CliOption,
  type CliMeta,
  type CommandContext,
} from './registry/index.js';
import {
  collectCliArgs,
  collectOptionParser,
  commandPath,
  fieldSchema,
  optionFlagSpec,
  positionalSpec,
  schemaKind,
} from '@titan-design/registry';
import { BUILD_VERSION } from './version.js';
import { color } from './utils/color.js';
import { appendUsage } from './utils/usage-log.js';
import { exitAfterFlush } from './utils/exit.js';
import { attachSpawnCommand } from './spawn/args.js';
import { processSpawnDeps } from './spawn/run.js';

/**
 * Walk/create a chain of `commander` sub-commands for the given group
 * parts (e.g. `['task']` for `task.add`). Returns the leaf parent so the
 * caller can attach the final action sub-command.
 */
function ensureGroup(root: Command, parts: string[]): Command {
  let current = root;
  for (const part of parts) {
    const existing = current.commands.find((c) => c.name() === part);
    if (existing) {
      current = existing;
      continue;
    }
    const next = current.command(part).description(`${part} commands`);
    current = next;
  }
  return current;
}

interface InvocationOutput {
  exitCode: number;
  success: boolean;
}

async function emitSuccess(cmd: AnyCommand, result: unknown, ctx: CommandContext): Promise<void> {
  if (ctx.format === 'json') {
    process.stdout.write(JSON.stringify(successEnvelope(result, ctx.warnings)) + '\n');
    return;
  }
  // Human mode: a bare string result is printed raw (e.g. `prompt` dumps the
  // bootstrap text); everything else is pretty-printed JSON for now. Commands
  // can layer richer output later by checking ctx.format themselves.
  if (typeof result === 'string') {
    process.stdout.write(result.endsWith('\n') ? result : result + '\n');
  } else if (result !== undefined && result !== null) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  }
  // Touch cmd to avoid an unused-parameter warning when extending later.
  void cmd;
}

export function emitError(message: string, code: number, format: 'human' | 'json'): void {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(errorEnvelope(message, code)) + '\n');
    return;
  }
  process.stderr.write(color.red('error: ' + message) + '\n');
}

/**
 * Build the action handler for a single registry command.
 *
 * Captures positionals + options into a plain object, coerces values to
 * the types implied by the command's zod schema, runs the schema, then
 * invokes `cmd.run`. Always writes a usage-log line and exits with the
 * appropriate sysexits code.
 */
function makeAction(
  cmd: AnyCommand,
  rootProgram: Command,
): (...handlerArgs: unknown[]) => Promise<void> {
  return async (...handlerArgs: unknown[]) => {
    const start = Date.now();
    const rootOpts = rootProgram.opts() as { json?: boolean };
    const format: 'human' | 'json' = rootOpts.json ? 'json' : 'human';
    const raw = collectRawArgs(cmd, handlerArgs);
    const ctx: CommandContext = {
      activeRoot: getActiveRoot(),
      warnings: [],
      format,
      cwd: process.cwd(),
      caller: agentCaller(process.env),
    };

    const result = await invoke(cmd, raw, ctx, format);
    await appendUsage({
      ts: new Date().toISOString(),
      command: cmd.name,
      args: raw,
      duration_ms: Date.now() - start,
      success: result.success,
      exit_code: result.exitCode,
    });
    await exitAfterFlush(result.exitCode);
  };
}

/** Gather commander's positionals and options into one object, coerced to the zod field types. */
function collectRawArgs(cmd: AnyCommand, handlerArgs: unknown[]): Record<string, unknown> {
  const positionalCount = (cmd.cli?.positional ?? []).length;
  const opts = (handlerArgs[positionalCount] ?? {}) as Record<string, unknown>;
  return collectCliArgs(cmd, handlerArgs.slice(0, positionalCount), opts);
}

async function invoke(
  cmd: AnyCommand,
  raw: Record<string, unknown>,
  ctx: CommandContext,
  format: 'human' | 'json',
): Promise<InvocationOutput> {
  if (raw.quiet === true && format === 'json') {
    emitError('--quiet and --json cannot be combined', EXIT.USAGE, format);
    return { exitCode: EXIT.USAGE, success: false };
  }
  let parsed: unknown;
  try {
    parsed = cmd.args.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emitError(`invalid arguments: ${message}`, EXIT.USAGE, format);
    return { exitCode: EXIT.USAGE, success: false };
  }

  try {
    const result = await cmd.run(parsed, ctx);
    await emitSuccess(cmd, result, ctx);
    return { exitCode: EXIT.OK, success: true };
  } catch (err) {
    const { message, code } = formatError(err);
    emitError(message, code, format);
    return { exitCode: code, success: false };
  }
}

/** Single-tag flags: commander would keep only the last of a repeat and drop the rest silently. */
const SINGLE_USE_OPTIONS: ReadonlySet<string> = new Set([
  'task.edit:add_tag',
  'task.edit:remove_tag',
]);

function refuseRepeat(flag: string): (value: string, previous: string | undefined) => string {
  return (value, previous) => {
    if (previous !== undefined) {
      throw new InvalidArgumentError(`${flag} takes one tag per call; repeat the command instead`);
    }
    return value;
  };
}

type Accumulator = (value: string, previous: string[] | undefined) => string[];

/**
 * Array flags take one value per occurrence. A comma is refused rather than kept, because
 * `--tags a,b` from a caller used to the old comma lists would otherwise store one wrong value.
 */
function refuseCommaList(long: string, accumulate: Accumulator): Accumulator {
  const flag = long.split(/\s/)[0];
  return (value, previous) => {
    if (value.includes(',')) {
      const parts = value.split(',').map((part) => part.trim()).filter((part) => part.length > 0);
      const repeated = parts.map((part) => `${flag} ${part}`).join(' ');
      throw new InvalidArgumentError(`${flag} ${value}: pass ${repeated}`);
    }
    return accumulate(value, previous);
  };
}

function attachOption(sub: Command, cmd: AnyCommand, key: string, opt: CliOption): void {
  const flags = optionFlagSpec(cmd, key, opt);
  const accumulate = collectOptionParser(cmd, key);
  const collect = accumulate && refuseCommaList(opt.long, accumulate);
  if (opt.required && collect) {
    sub.requiredOption(flags, opt.description, collect);
  } else if (opt.required) {
    sub.requiredOption(flags, opt.description);
  } else if (collect) {
    sub.option(flags, opt.description, collect);
  } else if (SINGLE_USE_OPTIONS.has(`${cmd.name}:${key}`)) {
    sub.option(flags, opt.description, refuseRepeat(opt.long));
  } else {
    sub.option(flags, opt.description);
  }
}

/** Attach one registry command as a sub-command under its appropriate parent. */
function attachCommand(root: Command, cmd: AnyCommand): void {
  const parts = commandPath(cmd.name);
  const leafName = parts[parts.length - 1]!;
  const parent = ensureGroup(root, parts.slice(0, -1));
  const sub = parent.command(leafName).description(cmd.description);

  const meta: CliMeta = cmd.cli ?? {};
  for (const pname of meta.positional ?? []) {
    const kind = schemaKind(fieldSchema(cmd.args, pname));
    sub.argument(positionalSpec(cmd, pname), `${pname}${kind ? ` (${kind})` : ''}`);
  }

  for (const [key, opt] of Object.entries(meta.options ?? {})) {
    attachOption(sub, cmd, key, opt);
  }

  sub.action(makeAction(cmd, root));
}

/** Side-effect free so the CLI reference generator can walk the tree in process instead of spawning per command. */
export function buildProgram(): Command {
  const program = new Command();
  // exitOverride must be set before sub-commands are created so the
  // setting is inherited via `copyInheritedSettings`. Sub-commands then
  // throw a `CommanderError` instead of calling `process.exit` directly.
  program.exitOverride();
  program
    .name('active-work')
    .description('active-work CLI — durable workspace state for engineering work')
    .version(BUILD_VERSION)
    .option('--json', 'emit machine-readable JSON envelope on stdout')
    .addHelpText(
      'after',
      '\nRun `active-work <command> --help` for command-specific options.\n' +
        'Tip: `aw [slug]` launches Claude with the bootstrap prompt.\n',
    );

  // Sort commands so help output is stable.
  const cmds = registry.list();
  for (const cmd of cmds) {
    attachCommand(program, cmd);
  }
  attachSpawnCommand(program, processSpawnDeps(exitAfterFlush));

  return program;
}
