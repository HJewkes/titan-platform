import { buildReport, RULES_PATH, summaryLine, unreadableLine } from "./report.js";
import { parseRules } from "./rules.js";
import { scan } from "./scan.js";
import type { SourceFile } from "./scan.js";

export const MAX_FILE_BYTES = 1_000_000;

/** Everything the lint touches outside itself; the real implementation only reads. */
export interface RunIo {
  env: Readonly<Record<string, string | undefined>>;
  readRules: (path: string) => string | null;
  /** Tracked text files of the working tree; binary and oversized ones are dropped, a file that cannot be read is listed. */
  trackedFiles: () => { files: SourceFile[]; unreadable: string[] };
  readStdin: () => string;
  out: (line: string) => void;
  err: (line: string) => void;
}

interface Args {
  stdin: boolean;
  name: string;
  rules: string;
}

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { stdin: false, name: "stdin", rules: RULES_PATH };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--stdin") args.stdin = true;
    else if ((flag === "--name" || flag === "--rules") && value !== undefined) {
      args[flag === "--name" ? "name" : "rules"] = value;
      i++;
    } else return `unknown argument: ${flag}`;
  }
  return args;
}

/** Exit 0 at warn whatever was found; at error 1 for an unallowed hit; 2 for an unusable rule file or arguments. */
export function run(argv: readonly string[], io: RunIo): number {
  const args = parseArgs(argv);
  if (typeof args === "string") return fail(io, args);
  const source = io.readRules(args.rules);
  if (source === null) return fail(io, `cannot read ${args.rules}`);
  const parsed = parseRules(source);
  if (!parsed.ok) return fail(io, `${args.rules}: ${parsed.error}`);
  const { rules } = parsed;
  const { files, unreadable } = args.stdin ? { files: [{ path: args.name, text: io.readStdin() }], unreadable: [] } : io.trackedFiles();
  const result = scan(files, rules, { scoped: !args.stdin });
  const actions = io.env.GITHUB_ACTIONS === "true";
  const report = buildReport(result, rules, actions);
  for (const line of [...report.lines, ...unreadable.map((path) => unreadableLine(path, actions))]) io.out(line);
  io.out(summaryLine(result, report, rules.level));
  return rules.level === "error" && report.unallowed > 0 ? 1 : 0;
}

function fail(io: RunIo, message: string): number {
  io.err(`merge-lint: ${message}`);
  return 2;
}
