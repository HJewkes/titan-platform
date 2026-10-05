import * as path from "node:path";
import type { Readable } from "node:stream";
import { handle } from "./hook.js";
import type { DecideFn } from "./hook.js";
import { logPath } from "./log.js";
import { GUARDED_PATHS, matchGuarded } from "./paths.js";
import type { ClassifyContext } from "./types.js";

export interface CliIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly context: ClassifyContext;
  /** All of stdin, or null when it has not ended within `ms`. */
  readStdin(ms: number): Promise<string | null>;
  /** Appends lines to the guard log; the only write the package makes. */
  appendLog(file: string, lines: readonly string[]): void;
  /** A file's text, or null when it does not exist. */
  readFile(file: string): string | null;
  /** Realpath of an existing path; throws when it does not exist. */
  realpath(p: string): string;
  now(): Date;
  loadDecide(): Promise<DecideFn>;
  out(line: string): void;
  err(line: string): void;
}

export const STDIN_TIMEOUT_MS = 2000;

const HOOK_COMMAND = 'node "$HOME/.claude/hooks/authority-guard/node_modules/@titan-design/tool-guard/dist/bin.js" hook';

/** The PreToolUse entry the owner pastes into `hooks.PreToolUse`, after the git-safety entry. */
export const SETTINGS_ENTRY = {
  matcher: "Bash|Read|Grep|Edit|Write|MultiEdit|NotebookEdit",
  hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 5 }],
} as const;

const USAGE = [
  "usage: titan-tool-guard <command>",
  "  hook            answer one PreToolUse event on stdin; always exits 0",
  "  print-settings  print the PreToolUse settings entry as JSON; writes nothing",
  "  report          print deny counts per day and rule from the guard log",
];

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "hook" && rest.length === 0) return runHook(io);
  if (command === "print-settings" && rest.length === 0) {
    io.out(JSON.stringify(SETTINGS_ENTRY, null, 2));
    return 0;
  }
  if (command === "report" && rest.length === 0) return runReport(io);
  for (const line of USAGE) io.err(line);
  return 2;
}

/** Exit 0 on every path: a non-zero exit or a hang is a non-blocking error that lets the tool run anyway. */
async function runHook(io: CliIo): Promise<number> {
  try {
    const input = await io.readStdin(STDIN_TIMEOUT_MS);
    if (input === null) return 0;
    const result = await handle(input, io.env, { context: io.context, now: io.now, loadDecide: io.loadDecide });
    if (result.stdout !== "") io.out(result.stdout);
    if (result.log.length > 0) appendQuietly(io, result.log);
  } catch {
    // Fail open: the error has nowhere safe to go but the log, and writing that is what failed.
  }
  return 0;
}

function appendQuietly(io: CliIo, lines: readonly string[]): void {
  const file = logPath(io.env, io.home);
  if (!isSafeLogPath(file, io.home, io.realpath)) return;
  try {
    io.appendLog(file, lines);
  } catch {
    // An unwritable log must not turn a deny into a crash, which would let the call through.
  }
}

/**
 * Refuses a log path that names a guarded file or lands in `~/.claude*`, as typed or after
 * resolving its deepest existing ancestor, so `TITAN_TOOL_GUARD_LOG=~/logs/settings.json` with
 * `~/logs` linked to `~/.claude` is not written. Checked just before the append; a link swapped in between is not caught.
 */
export function isSafeLogPath(file: string, home: string, realpath: (p: string) => string): boolean {
  if (!path.isAbsolute(file)) return false;
  const literal = path.resolve(file);
  const real = throughExistingAncestor(literal, realpath);
  if (real === null || !outsideGuarded(literal, home) || !outsideGuarded(real, home)) return false;
  const realHome = throughExistingAncestor(path.resolve(home), realpath);
  return realHome === null || outsideGuarded(real, realHome);
}

function throughExistingAncestor(literal: string, realpath: (p: string) => string): string | null {
  const rest: string[] = [];
  for (let dir = literal; ; dir = path.dirname(dir)) {
    try {
      return path.join(realpath(dir), ...rest);
    } catch {
      if (path.dirname(dir) === dir) return null;
      rest.unshift(path.basename(dir));
    }
  }
}

/** Outside every guarded path, and outside the `~/.claude*` trees, where a log never belongs. */
function outsideGuarded(file: string, home: string): boolean {
  if (/^\.claude[^/]*(\/|$)/.test(path.relative(home, file))) return false;
  const config = matchGuarded(file, GUARDED_PATHS.config, home);
  return matchGuarded(file, GUARDED_PATHS.secret, home) === null && (config === null || config.id === "home:tool-guard-state");
}

function runReport(io: CliIo): number {
  const text = io.readFile(logPath(io.env, io.home)) ?? "";
  for (const [key, count] of denyCounts(text)) io.out(`${key}\t${count}`);
  return 0;
}

/** Deny lines counted by UTC day and rule id, sorted by day then rule. */
export function denyCounts(text: string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    const [ts, kind, rule] = line.split("\t");
    if (kind !== "deny" || !ts || !rule) continue;
    const key = `${ts.slice(0, 10)}\t${rule}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Reads `stream` to its end, or resolves null after `ms` and releases it so the process can exit. */
export function readWithin(stream: Readable, ms: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const finish = (value: string | null): void => {
      clearTimeout(timer);
      stream.removeAllListeners("data").removeAllListeners("end").removeAllListeners("error");
      if (value === null) stream.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), ms);
    stream.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    stream.on("end", () => finish(Buffer.concat(chunks).toString("utf-8")));
    stream.on("error", () => finish(null));
  });
}
