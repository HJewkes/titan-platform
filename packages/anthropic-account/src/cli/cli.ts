import type { CliContext } from "./context.js";
import { runInstall, runUninstall } from "./install-command.js";
import { runPoll } from "./poll-command.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, PROGRAM } from "./report.js";
import { runStatus, type StatusFormat } from "./status-command.js";

export type { CliContext } from "./context.js";

const USAGE = [
  `usage: ${PROGRAM} poll [--write [--refresh]]`,
  `       ${PROGRAM} status [--json | --statusline]`,
  `       ${PROGRAM} install|uninstall [--dry-run]`,
  "",
  "poll       GET each profile's OAuth usage and print it; --write stores it as usage-poll.json",
  "--refresh  first renew each access token due within 10 minutes; this rewrites .credentials.json",
  "status     print each profile's login state and newest usage reading, with no network",
  "",
  "install    write the poll units (systemd --user, or a launchd agent on darwin) and enable them;",
  "           uninstall reverses it; --dry-run prints the files and commands and changes nothing",
  "",
  "poll skips a profile with no login, and one backing off after a 429",
  "",
  "exit 0 ok, 1 a poll, refresh or read failed, 2 a login is expired or refused (or, for status,",
  "missing), 64 usage",
].join("\n");

type Command = { run: (context: CliContext) => Promise<number> | number } | { usage: string };

// Flags are matched whole and never echoed, so nothing typed on the command line reaches
// the output.
function pollCommand(flags: Set<string>): Command {
  const known = [...flags].every((flag) => flag === "--write" || flag === "--refresh");
  if (!known) return { usage: "poll takes only --write and --refresh" };
  if (flags.has("--refresh") && !flags.has("--write")) return { usage: "--refresh needs --write" };
  const options = { write: flags.has("--write"), refresh: flags.has("--refresh") };
  return { run: (context) => runPoll(options, context) };
}

function statusCommand(flags: Set<string>): Command {
  const known = [...flags].every((flag) => flag === "--json" || flag === "--statusline");
  if (!known || flags.size > 1) return { usage: "status takes one of --json or --statusline" };
  const format: StatusFormat = flags.has("--json") ? "json" : flags.has("--statusline") ? "statusline" : "text";
  return { run: (context) => runStatus(format, context) };
}

function installCommand(name: "install" | "uninstall", flags: Set<string>): Command {
  if (![...flags].every((flag) => flag === "--dry-run")) return { usage: `${name} takes only --dry-run` };
  const options = { dryRun: flags.has("--dry-run") };
  return { run: (context) => (name === "install" ? runInstall(options, context) : runUninstall(options, context)) };
}

function commandFor(argv: readonly string[]): Command {
  const [name, ...rest] = argv;
  const flags = new Set(rest);
  if (flags.size !== rest.length) return { usage: "a flag is repeated" };
  if (name === "poll") return pollCommand(flags);
  if (name === "status") return statusCommand(flags);
  if (name === "install" || name === "uninstall") return installCommand(name, flags);
  return { usage: "expected poll, status, install or uninstall" };
}

// A thrown error's message is dropped, not printed: the library redacts its own, but the
// bin's stderr stays a fixed template either way.
export async function runCli(argv: readonly string[], context: CliContext): Promise<number> {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    context.out(USAGE);
    return EXIT_OK;
  }
  const command = commandFor(argv);
  if ("usage" in command) {
    context.err(`${PROGRAM}: ${command.usage}\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    return await command.run(context);
  } catch {
    context.err(`${PROGRAM}: an unexpected error stopped the run`);
    return EXIT_FAILED;
  }
}
