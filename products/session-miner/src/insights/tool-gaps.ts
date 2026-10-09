import { EXIT } from "@titan-design/registry";
import { LIST_PRICE_CAVEAT, scopeFilter, type CostReportOptions } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { defineInsight } from "./define.js";
import { OUR_CLIS, patternId, postFilters, type PostFilterUse } from "./post-filter.js";
import { outputCharsReader, readAgentNames, readBashCalls, readBashCommand, runHelp, type BashCall } from "./tool-gaps-sources.js";

/** Where the question reads what agents ran and what our CLIs offer; tests inject fixtures for both. */
export interface ToolGapsPorts {
  command(call: BashCall): Promise<string | null>;
  help(argv: readonly string[]): Promise<string | null>;
}

export const GAP_STATUSES = ["NEW", "EXISTS-UNUSED", "UNKNOWN"] as const;

const patternRow = z.object({
  patternId: z.string(),
  head: z.string(),
  pattern: z.string(),
  stages: z.array(z.string()),
  calls: z.number().int(),
  sessions: z.number().int(),
  agents: z.number().int(),
  outputChars: z.number().int(),
  status: z.enum(GAP_STATUSES),
  existingFlags: z.array(z.string()),
});

export const toolGapsSchema = z.object({
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  totals: z.object({ bashCalls: z.number().int(), skippedByHeads: z.number().int(), unreadable: z.number().int(), pipelines: z.number().int(), patterns: z.number().int(), sessions: z.number().int() }),
  patterns: z.array(patternRow),
});

export type ToolGapsReport = z.infer<typeof toolGapsSchema>;
export type ToolGapRow = z.infer<typeof patternRow>;

const LIMIT = ["--limit", "--last", "--tail", "--max", "--lines", "--first", "--top"];
const SELECT = ["--filter", "--search", "--grep", "--state", "--status", "--prefix", "--name", "--id", "--match", "--where", "--exclude", "--active"];
const SHAPE = ["--jq", "--fields", "--template", "--format", "--oneline", "--brief", "--summary"];
const COUNT = ["--count"];
/** The flags that would do a filter stage's job inside the CLI, by the stage's program. */
const REPLACEMENTS: Record<string, readonly string[]> = {
  head: LIMIT, tail: LIMIT, grep: SELECT, rg: SELECT, awk: [...SELECT, ...SHAPE], sed: [...SELECT, ...SHAPE],
  jq: SHAPE, python: SHAPE, python3: SHAPE, node: SHAPE, cut: SHAPE, column: SHAPE, sort: ["--sort"], uniq: COUNT, wc: COUNT,
};
const DEFAULT_TOP = 50;
const READ_CONCURRENCY = 32;
const NAMES_OUR_CLI = new RegExp(OUR_CLIS.join("|"));

export function replacementFlags(stage: string): readonly string[] {
  const [program = "", ...flags] = stage.split(" ");
  if (program === "grep" && flags.includes("-c")) return COUNT;
  return REPLACEMENTS[program] ?? [];
}

interface Use extends PostFilterUse {
  call: BashCall;
}

/** Every post-filter use among the calls; a call whose recorded heads name none of our CLIs is never read back. */
async function readUses(calls: readonly BashCall[], command: ToolGapsPorts["command"]) {
  const candidates = calls.filter((c) => c.heads === null || NAMES_OUR_CLI.test(c.heads));
  const uses: Use[] = [];
  let unreadable = 0;
  for (let i = 0; i < candidates.length; i += READ_CONCURRENCY) {
    const texts = await Promise.all(candidates.slice(i, i + READ_CONCURRENCY).map((call) => command(call)));
    texts.forEach((text, j) => {
      if (text === null) unreadable += 1;
      else uses.push(...postFilters(text).map((use) => ({ ...use, call: candidates[i + j]! })));
    });
  }
  return { uses, unreadable, skippedByHeads: calls.length - candidates.length };
}

interface Group {
  first: Use;
  uses: Use[];
}

function groupUses(uses: readonly Use[]): Group[] {
  const groups = new Map<string, Group>();
  for (const use of uses) {
    const key = `${use.head}\u0000${use.pattern}`;
    const group = groups.get(key) ?? { first: use, uses: [] };
    group.uses.push(use);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/** A flag counts as existing when the help names it and not every call already passes it. */
async function availability(group: Group, help: (argv: readonly string[]) => Promise<string | null>): Promise<Pick<ToolGapRow, "status" | "existingFlags">> {
  const text = await help(group.first.helpArgv);
  if (text === null) return { status: "UNKNOWN", existingFlags: [] };
  const alwaysPassed = group.uses.map((u) => new Set(u.headFlags)).reduce((a, b) => new Set([...a].filter((f) => b.has(f))));
  const wanted = new Set(group.first.stages.flatMap(replacementFlags));
  const existingFlags = [...wanted].filter((flag) => !alwaysPassed.has(flag) && namesFlag(text, flag)).sort();
  return { status: existingFlags.length > 0 ? "EXISTS-UNUSED" : "NEW", existingFlags };
}

function namesFlag(help: string, flag: string): boolean {
  return new RegExp(`(^|[\\s,\\[(|])${flag}(?=[\\s=,\\])|]|$)`, "m").test(help);
}

function summarise(group: Group, agents: ReadonlyMap<string, string>, outputChars: (call: BashCall) => number): Omit<ToolGapRow, "status" | "existingFlags"> {
  const { head, pattern, stages } = group.first;
  const sessions = new Set(group.uses.map((u) => u.call.sessionId));
  const calls = new Map(group.uses.map((u) => [u.call.toolUseId, u.call]));
  return {
    patternId: patternId(pattern),
    head,
    pattern,
    stages,
    calls: group.uses.length,
    sessions: sessions.size,
    agents: new Set([...sessions].flatMap((s) => agents.get(s) ?? [])).size,
    outputChars: [...calls.values()].reduce((sum, call) => sum + outputChars(call), 0),
  };
}

/** Memoises by argv, so each CLI's help runs once per answer. */
function onceEach(help: ToolGapsPorts["help"]): ToolGapsPorts["help"] {
  const seen = new Map<string, Promise<string | null>>();
  return (argv) => {
    const key = argv.join(" ");
    if (!seen.has(key)) seen.set(key, help(argv));
    return seen.get(key)!;
  };
}

const byCallsThenId = (a: ToolGapRow, b: ToolGapRow) => b.calls - a.calls || a.head.localeCompare(b.head) || a.patternId.localeCompare(b.patternId);

export async function toolGapsReport(db: Db, report: CostReportOptions, top: number, ports: ToolGapsPorts): Promise<ToolGapsReport> {
  const inScope = scopeFilter(db, report.scope);
  const calls = readBashCalls(db, report).filter((c) => inScope({ sessionId: c.sessionId, role: "" }));
  const { uses, unreadable, skippedByHeads } = await readUses(calls, ports.command);
  const agents = readAgentNames(db);
  const outputChars = outputCharsReader(db);
  const help = onceEach(ports.help);
  const rows = await Promise.all(groupUses(uses).map(async (g) => ({ ...summarise(g, agents, outputChars), ...(await availability(g, help)) })));
  return {
    window: { since: report.since ?? null, until: report.until ?? null },
    totals: { bashCalls: calls.length, skippedByHeads, unreadable, pipelines: uses.length, patterns: rows.length, sessions: new Set(uses.map((u) => u.call.sessionId)).size },
    patterns: rows.sort(byCallsThenId).slice(0, top),
  };
}

const cell = (value: string | number) => String(value).replaceAll("|", "\\|");

export function renderToolGapsText(data: ToolGapsReport): string {
  const { totals, window } = data;
  const header = [
    `Tool gaps: post-filters piped after our CLIs, ${window.since ?? "beginning"} to ${window.until ?? "now"}`,
    `${totals.pipelines} pipelines in ${totals.patterns} patterns over ${totals.sessions} sessions, from ${totals.bashCalls} Bash calls ` +
      `(${totals.skippedByHeads} ruled out by recorded heads, ${totals.unreadable} unreadable).`,
    "NEW: the CLI's --help names no flag that does the filter's job. EXISTS-UNUSED: it does, and the flags are listed.",
  ].join("\n");
  const rows = data.patterns.map((r) =>
    `| ${[r.patternId, r.head, r.pattern, r.calls, r.sessions, r.agents, r.outputChars, r.status, r.existingFlags.join(" ")].map(cell).join(" | ")} |`);
  const table = ["| id | head | pattern | calls | sessions | agents | output chars | status | existing flags |", "|---|---|---|---:|---:|---:|---:|---|---|", ...rows];
  return [header, table.join("\n"), LIST_PRICE_CAVEAT].join("\n\n") + "\n";
}

export const DEFAULT_TOOL_GAPS_PORTS: ToolGapsPorts = { command: (call) => readBashCommand(call), help: runHelp };

export function toolGapsQuestion(ports: ToolGapsPorts = DEFAULT_TOOL_GAPS_PORTS) {
  return defineInsight<{ top?: number }, ToolGapsReport>({
    id: "Q9",
    name: "tool-gaps",
    description: "Post-filters agents pipe after our CLIs, grouped by normalised pattern and marked NEW or EXISTS-UNUSED against each CLI's --help",
    options: { top: z.number().int().positive().optional().describe(`patterns to return, most calls first (default ${DEFAULT_TOP})`) },
    flags: { top: { long: "--top", description: `patterns to return (default ${DEFAULT_TOP})` } },
    schema: toolGapsSchema,
    async answer(db, report, options) {
      if (report.scope?.roles !== undefined) throw Object.assign(new Error("tool-gaps does not take role; narrow it with --session or --agent-prefix"), { code: EXIT.DATAERR });
      const data = await toolGapsReport(db, report, options.top ?? DEFAULT_TOP, ports);
      return { data, text: renderToolGapsText(data) };
    },
  });
}

export const toolGaps = toolGapsQuestion();
