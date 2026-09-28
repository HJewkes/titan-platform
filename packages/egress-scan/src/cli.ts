import { parseArgs } from "node:util";
import { ConfigError, loadAllow, loadTerms } from "./config.js";
import type { ScanSource } from "./diff.js";
import { commitsForRange, commitsForUpdate, parsePrePush, readCommit, readTree, repoRoot } from "./git.js";
import { installHook, type InstallResult } from "./install.js";
import { formatReport } from "./report.js";
import { scan } from "./scan.js";

export interface CliIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readStdin(): string;
  out(line: string): void;
  err(line: string): void;
}

const USAGE = [
  "usage: titan-egress-scan <command>",
  "  pre-push <remote>     scan the commits a push sends (reads git's pre-push stdin)",
  "  range <base> <head>   scan every commit in base..head (CI)",
  "  tree                  scan every tracked file at HEAD",
  "  install-hook          install the pre-push hook into git's hooks directory",
  "exit: 0 clean, 1 findings, 2 usage or configuration error",
];

const PREFIX = "titan-egress-scan: ";

function readCommits(root: string, shas: readonly string[]): ScanSource[] {
  return [...new Set(shas)].map((sha) => readCommit(root, sha));
}

function prePushSources(root: string, remote: string, stdin: string): ScanSource[] {
  const updates = parsePrePush(stdin);
  return readCommits(
    root,
    updates.flatMap((update) => commitsForUpdate(root, remote, update)),
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

function dispatch(command: string | undefined, args: readonly string[], io: CliIo): number {
  switch (command) {
    case "pre-push":
      // git passes the remote name and its URL; only the name is used.
      expectArgs(command, args, 1, 2);
      return runScan(io, (root) => prePushSources(root, args[0] ?? "", io.readStdin()));
    case "range":
      expectArgs(command, args, 2, 2);
      return runScan(io, (root) => readCommits(root, commitsForRange(root, args[0] ?? "", args[1] ?? "")));
    case "tree":
      expectArgs(command, args, 0, 0);
      return runScan(io, (root) => [readTree(root)]);
    case "install-hook":
      expectArgs(command, args, 0, 0);
      return runInstall(io);
    default:
      throw new ConfigError(command === undefined ? "missing command" : "unknown command");
  }
}

/** Runs one command. Errors print as one line to stderr and exit 2; nothing echoes scanned text. */
export function runCli(argv: readonly string[], io: CliIo): number {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" } },
    });
    if (values.help) {
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
