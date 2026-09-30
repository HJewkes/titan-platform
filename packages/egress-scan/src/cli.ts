import { parseArgs } from "node:util";
import { ConfigError, loadAllow, loadTerms } from "./config.js";
import type { ScanSource } from "./diff.js";
import {
  commitsForRange,
  commitsForUpdate,
  isRemoteName,
  isRevision,
  parsePrePush,
  readCommit,
  readTree,
  repoRoot,
} from "./git.js";
import { installHook, type InstallResult } from "./install.js";
import { formatReport } from "./report.js";
import { scan } from "./scan.js";

export interface CliIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readStdin(): string;
  out(line: string): void;
  err(line: string): void;
  /** Overrides `MAX_PATCH_BYTES` for tests; the bin never sets it. */
  readonly maxPatchBytes?: number;
}

const USAGE = [
  "usage: titan-egress-scan <command>",
  "  pre-push <remote>     scan the commits a push sends (reads git's pre-push stdin)",
  "  range <base> <head>   scan every commit in base..head (CI)",
  "  tree                  scan every tracked file at HEAD",
  "  install-hook          install the pre-push hook into git's hooks directory",
  "files git calls binary are scanned as text; a commit or tree over 128 MiB of patch text exits 2",
  "exit: 0 clean, 1 findings, 2 usage or configuration error",
];

const PREFIX = "titan-egress-scan: ";

function readCommits(root: string, shas: readonly string[], maxPatchBytes?: number): ScanSource[] {
  return [...new Set(shas)].map((sha) => readCommit(root, sha, maxPatchBytes));
}

function prePushSources(root: string, remote: string, io: CliIo): ScanSource[] {
  const updates = parsePrePush(io.readStdin());
  return readCommits(
    root,
    updates.flatMap((update) => commitsForUpdate(root, remote, update)),
    io.maxPatchBytes,
  );
}

function runScan(io: CliIo, collect: (root: string) => ScanSource[]): number {
  const root = repoRoot(io.cwd);
  const allow = loadAllow(root);
  const { terms, loaded, notices } = loadTerms(io.env);
  for (const notice of notices) io.err(PREFIX + notice);
  const result = scan(collect(root), { terms, allow });
  for (const line of formatReport(result.findings, { ...result, termsLoaded: loaded })) io.out(line);
  return result.findings.length > 0 ? 1 : 0;
}

const INSTALL_MESSAGES: Record<InstallResult["outcome"], string> = {
  installed: "pre-push hook installed",
  updated: "pre-push hook updated",
  unchanged: "pre-push hook already installed",
  "skipped-in-ci": "CI detected; hook not installed",
  "foreign-hook": "an existing pre-push hook was not written by this tool; left it in place.",
};

function runInstall(io: CliIo): number {
  const result = installHook(io.cwd, io.env);
  const where = result.hookPath === undefined ? "" : ` (${result.hookPath})`;
  if (result.outcome !== "foreign-hook") {
    io.out(PREFIX + INSTALL_MESSAGES[result.outcome] + where);
    return 0;
  }
  io.err(PREFIX + INSTALL_MESSAGES[result.outcome] + where);
  io.err(PREFIX + 'chain it: call `titan-egress-scan pre-push "$1"` from that hook with git\'s stdin passed through');
  return 2;
}

function expectArgs(command: string, args: readonly string[], min: number, max: number): void {
  if (args.length < min || args.length > max) throw new ConfigError(`${command}: wrong number of arguments`);
}

/** Rejects a value by its position only, so the message never repeats what was passed. */
function expectValid(command: string, args: readonly string[], valid: (value: string) => boolean, what: string): void {
  args.forEach((value, i) => {
    if (!valid(value)) throw new ConfigError(`${command}: argument ${i + 1} is not ${what}`);
  });
}

function dispatch(command: string | undefined, args: readonly string[], io: CliIo): number {
  switch (command) {
    case "pre-push":
      // git passes the remote name and its URL; only the name is used.
      expectArgs(command, args, 1, 2);
      expectValid(command, args.slice(0, 1), isRemoteName, "a remote name");
      return runScan(io, (root) => prePushSources(root, args[0] ?? "", io));
    case "range":
      expectArgs(command, args, 2, 2);
      expectValid(command, args, isRevision, "a sha or ref name");
      return runScan(io, (root) =>
        readCommits(root, commitsForRange(root, args[0] ?? "", args[1] ?? ""), io.maxPatchBytes),
      );
    case "tree":
      expectArgs(command, args, 0, 0);
      return runScan(io, (root) => [readTree(root, io.maxPatchBytes)]);
    case "install-hook":
      expectArgs(command, args, 0, 0);
      return runInstall(io);
    default:
      throw new ConfigError(command === undefined ? "missing command" : "unknown command");
  }
}

/** Help counts only before the command; after it, a help flag is a usage error, never a skipped scan. */
function parseCommandLine(argv: readonly string[]): { positionals: string[]; help: boolean } {
  const { positionals, tokens } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    tokens: true,
    options: { help: { type: "boolean", short: "h" } },
  });
  const command = tokens.find((token) => token.kind === "positional");
  const helps = tokens.filter((token) => token.kind === "option" && token.name === "help");
  if (helps.some((token) => command !== undefined && token.index > command.index)) {
    throw new ConfigError("a help flag after the command is not allowed");
  }
  return { positionals, help: helps.length > 0 };
}

/** Runs one command. Errors print as one line to stderr and exit 2; nothing echoes scanned text. */
export function runCli(argv: readonly string[], io: CliIo): number {
  try {
    const { positionals, help } = parseCommandLine(argv);
    if (help) {
      for (const line of USAGE) io.out(line);
      return 0;
    }
    return dispatch(positionals[0], positionals.slice(1), io);
  } catch (error) {
    io.err(PREFIX + (error instanceof Error ? error.message : "unexpected error"));
    if (error instanceof ConfigError) io.err(USAGE[0] ?? "");
    return 2;
  }
}
