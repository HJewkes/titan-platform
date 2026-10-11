import os from "node:os";
import { readLocatorText } from "@titan-design/locator";
import { EXIT } from "@titan-design/registry";
import { LIST_PRICE_CAVEAT, scopeFilter, type CostReportOptions, type DenialRecord } from "@titan-design/session-analytics";
import { expandHome } from "@titan-design/session-read";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { readDenials } from "./blocked-flow-sources.js";
import { defineInsight, localDay } from "./define.js";
import { readAgentNames } from "./tool-gaps-sources.js";

/** The self-improve extractor's error classes in match order: first hit wins, so a classifier denial is never "permission-denied". */
const CLASS_PATTERNS = [
  ["classifier-denial", /classifier\. Reason/i],
  ["permission-denied", /Permission to use .* (has been )?denied|permission.*denied by|was denied/i],
  ["user-rejected", /doesn't want to proceed|user rejected|The user doesn't want/i],
  ["sleep-block", /Blocked: sleep|sleep .* is blocked/i],
  ["wrong-tool-name", /No such tool available/i],
  ["hook-block", /hook (error|blocked)|PreToolUse.*(blocked|denied)|Blocked: /i],
  ["edit-not-read", /File has not been read yet|must Read the file/i],
  ["edit-no-match", /String to replace not found|old_string.*not found|not unique/i],
  ["file-missing", /No such file or directory|File does not exist|ENOENT/i],
  ["gh-graphql-ratelimit", /GraphQL: API rate limit/i],
  ["gh-secondary-ratelimit", /secondary rate limit/i],
  ["gh-other", /gh: |HTTP 4\d\d|HTTP 5\d\d/i],
  ["git-error", /fatal: |error: (failed to push|pathspec|Your local changes)|non-fast-forward|CONFLICT/i],
  ["timeout", /timed out|Command timed out|ETIMEDOUT/i],
  ["mcp-tool-error", /InputValidationError|Invalid input|MCP error/i],
  ["agent-chat-refused", /no active session named|spawn failed|no free agent slots|refused/i],
  ["test-fail", /(\d+ failed|FAIL |Tests? failed|AssertionError)/i],
  ["lint-type", /error TS\d+|eslint|✖ \d+ problems/i],
  ["exit-code", /Exit code \d+/i],
] as const satisfies readonly (readonly [string, RegExp])[];

/** `unreadable` is an error whose transcript line is gone or moved, so its text cannot be classed. */
const ERROR_CLASSES = [...CLASS_PATTERNS.map(([name]) => name), "other", "unreadable"] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

function classifyError(text: string): ErrorClass {
  return CLASS_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "other";
}

const DENIAL_REASON = /classifier\. Reason: \[([^\]]+)\]/;

/** An error tool result in the graph, located in its transcript; the graph keeps no result text. */
const errorResultRows = z.array(
  z.object({
    sessionId: z.string(),
    toolUseId: z.string(),
    ts: z.string(),
    /** As the graph stores it, which may start with `~/`. */
    path: z.string(),
    byteOffset: z.number().int(),
    /** Null when no fact row gives the line's length, so it cannot be read back. */
    byteLength: z.number().int().nullable(),
    /** The called tool's name, or null when its call is not in the graph. */
    tool: z.string().nullable(),
  }),
);
type ErrorResult = z.infer<typeof errorResultRows>[number];

const ERROR_RESULTS = `
  SELECT i.session_id AS sessionId, i.tool_use_id AS toolUseId, i.ts AS ts, t.source_key AS path, i.byte_offset AS byteOffset,
         f.byte_length AS byteLength,
         (SELECT tc.name FROM tool_call tc WHERE tc.session_id = i.session_id AND tc.tool_use_id = i.tool_use_id LIMIT 1) AS tool
  FROM inbound i
  JOIN transcript t ON t.source_id = i.transcript_id
  LEFT JOIN fact f ON f.transcript_id = i.transcript_id AND f.byte_offset = i.byte_offset AND f.event_type = 'tool_result_error'
  WHERE i.cause = 'tool_result' AND i.is_error = 1 AND i.tool_use_id IS NOT NULL
    AND (@since IS NULL OR i.ts >= @since) AND (@until IS NULL OR i.ts < @until)
  ORDER BY i.ts`;

function readErrorResults(db: Db, window: { since?: string; until?: string }): ErrorResult[] {
  const rows = errorResultRows.parse(db.prepare(ERROR_RESULTS).all({ since: window.since ?? null, until: window.until ?? null }));
  return [...new Map(rows.map((r) => [`${r.sessionId}\u0000${r.toolUseId}`, r])).values()];
}

const transcriptLine = z.object({ message: z.object({ content: z.array(z.unknown()) }) });
const resultBlock = z.object({ type: z.literal("tool_result"), tool_use_id: z.string(), content: z.unknown() });
const textBlock = z.object({ type: z.literal("text"), text: z.string() });

/** The text of the result's `tool_result` block, or null when the line is gone, moved or not that result. */
async function readErrorText(result: ErrorResult, home: string = os.homedir()): Promise<string | null> {
  if (result.byteLength === null) return null;
  try {
    const line = transcriptLine.safeParse(JSON.parse(await readLocatorText(expandHome(result.path, home), [0, result.byteOffset, result.byteLength])));
    const blocks = line.success ? line.data.message.content.map((b) => resultBlock.safeParse(b)) : [];
    const block = blocks.find((b) => b.success && b.data.tool_use_id === result.toolUseId);
    return block?.success ? resultText(block.data.content) : null;
  } catch {
    return null;
  }
}

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = z.array(z.unknown()).safeParse(content);
  if (!blocks.success) return "";
  return blocks.data.flatMap((b) => {
    const text = textBlock.safeParse(b);
    return text.success ? [text.data.text] : [];
  }).join("\n");
}

/** One error, classed, with who hit it; a transcript denial has a seat in place of a session. */
interface ClassifiedError {
  toolUseId: string | null;
  day: string;
  class: ErrorClass;
  /** MCP tools by their last segment, as the extractor named them. */
  tool: string;
  sessionId: string | null;
  agent: string | null;
  /** The classifier's bracketed reason, for a classifier denial that gives one. */
  reason: string | null;
}

const shortTool = (name: string) => name.split("__").at(-1) ?? name;

const READ_CONCURRENCY = 32;

/** Every error result in the window and scope, classed from its transcript text. */
async function classifyGraphErrors(db: Db, report: CostReportOptions): Promise<ClassifiedError[]> {
  const inScope = scopeFilter(db, report.scope);
  const results = readErrorResults(db, report).filter((r) => inScope({ sessionId: r.sessionId, role: "" }));
  const agents = readAgentNames(db);
  const texts: (string | null)[] = [];
  for (let i = 0; i < results.length; i += READ_CONCURRENCY) texts.push(...(await Promise.all(results.slice(i, i + READ_CONCURRENCY).map((r) => readErrorText(r)))));
  return results.map((r, i) => {
    const text = texts[i] ?? null;
    return {
      toolUseId: r.toolUseId,
      day: localDay(r.ts),
      class: text === null ? "unreadable" : classifyError(text),
      tool: shortTool(r.tool ?? "unknown"),
      sessionId: r.sessionId,
      agent: agents.get(r.sessionId) ?? null,
      reason: text === null ? null : (DENIAL_REASON.exec(text)?.[1] ?? null),
    };
  });
}

/** Transcript denials in the window that the graph has not already counted under the same tool_use_id. */
function transcriptDenials(denials: readonly DenialRecord[], window: { since?: string; until?: string }, graphToolUseIds: ReadonlySet<string>): ClassifiedError[] {
  return denials
    .filter((d) => (!d.toolUseId || !graphToolUseIds.has(d.toolUseId)) && (!window.since || d.at >= window.since) && (!window.until || d.at < window.until))
    .map((d) => ({ toolUseId: d.toolUseId ?? null, day: localDay(d.at), class: "classifier-denial", tool: shortTool(d.tool), sessionId: null, agent: d.seat, reason: d.reason }));
}

const countRow = { count: z.number().int(), sessions: z.number().int(), agents: z.number().int() };

export const toolErrorsSchema = z.object({
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  totals: z.object({ errors: z.number().int(), unreadable: z.number().int(), fromTranscripts: z.number().int(), sessions: z.number().int(), agents: z.number().int() }),
  byClass: z.array(z.object({ day: z.string(), class: z.enum(ERROR_CLASSES), ...countRow })),
  byTool: z.array(z.object({ day: z.string(), tool: z.string(), ...countRow })),
  denials: z.array(z.object({ day: z.string(), reason: z.string(), count: z.number().int() })),
});

export type ToolErrorsReport = z.infer<typeof toolErrorsSchema>;

function tally(errors: readonly ClassifiedError[]) {
  return {
    count: errors.length,
    sessions: new Set(errors.flatMap((e) => e.sessionId ?? [])).size,
    agents: new Set(errors.flatMap((e) => e.agent ?? [])).size,
  };
}

function groupBy<K extends string>(errors: readonly ClassifiedError[], key: (e: ClassifiedError) => K): [string, K, ClassifiedError[]][] {
  const groups = new Map<string, ClassifiedError[]>();
  for (const e of errors) {
    const k = `${e.day}\u0000${key(e)}`;
    groups.set(k, (groups.get(k) ?? []).concat(e));
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, group]) => [k.split("\u0000")[0]!, key(group[0]!), group]);
}

function toolErrorsReport(errors: readonly ClassifiedError[], window: { since?: string; until?: string }): ToolErrorsReport {
  const denials = errors.filter((e) => e.reason !== null);
  const { sessions, agents } = tally(errors);
  const unreadable = errors.filter((e) => e.class === "unreadable").length;
  return {
    window: { since: window.since ?? null, until: window.until ?? null },
    totals: { errors: errors.length, unreadable, fromTranscripts: errors.filter((e) => e.sessionId === null).length, sessions, agents },
    byClass: groupBy(errors, (e) => e.class).map(([day, cls, group]) => ({ day, class: cls, ...tally(group) })),
    byTool: groupBy(errors, (e) => e.tool).map(([day, tool, group]) => ({ day, tool, ...tally(group) })),
    denials: groupBy(denials, (e) => e.reason!).map(([day, reason, group]) => ({ day, reason, count: group.length })),
  };
}

const cell = (value: string | number) => String(value).replaceAll("|", "\\|");

function table(header: string[], rows: (string | number)[][]): string {
  const align = header.map((h) => (["count", "sessions", "agents"].includes(h) ? "---:" : "---"));
  return [`| ${header.join(" | ")} |`, `|${align.join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");
}

function renderToolErrorsText(data: ToolErrorsReport): string {
  const { totals, window } = data;
  const header = [
    `Tool errors by class and tool per local day, ${window.since ?? "beginning"} to ${window.until ?? "now"}`,
    `${totals.errors} errors over ${totals.sessions} sessions and ${totals.agents} agents (${totals.unreadable} unreadable, ${totals.fromTranscripts} from --transcript).`,
  ].join("\n");
  const byClass = table(["day", "class", "count", "sessions", "agents"], data.byClass.map((r) => [r.day, r.class, r.count, r.sessions, r.agents]));
  const byTool = table(["day", "tool", "count", "sessions", "agents"], data.byTool.map((r) => [r.day, r.tool, r.count, r.sessions, r.agents]));
  const denials = table(["day", "reason", "count"], data.denials.map((r) => [r.day, r.reason, r.count]));
  return [header, byClass, byTool, denials, LIST_PRICE_CAVEAT].join("\n\n") + "\n";
}

const seatPathSpec = z.string().regex(/^[^=]+=.+$/, "expected <seat>=<path>");

/** Q5's answer for a window, shared with the probes question. */
export async function answerToolErrors(db: Db, report: CostReportOptions, transcripts: readonly string[]): Promise<ToolErrorsReport> {
  if (report.scope?.roles !== undefined) throw Object.assign(new Error("tool-errors does not take role; narrow it with --session or --agent-prefix"), { code: EXIT.DATAERR });
  const sessionScoped = report.scope?.sessionIds !== undefined || report.scope?.agentPrefix !== undefined;
  if (sessionScoped && transcripts.length > 0) throw Object.assign(new Error("--transcript denials have no session, so tool-errors refuses them with --session or --agent-prefix"), { code: EXIT.DATAERR });
  const graph = await classifyGraphErrors(db, report);
  const graphIds = new Set(graph.flatMap((e) => e.toolUseId ?? []));
  return toolErrorsReport([...graph, ...transcriptDenials(transcripts.flatMap(readDenials), report, graphIds)], report);
}

export const toolErrors = defineInsight<{ transcript?: string[] }, ToolErrorsReport>({
  id: "Q5",
  name: "tool-errors",
  description: "Error tool results and classifier denials per local day, by error class and by tool, with sessions and agents",
  options: { transcript: z.array(seatPathSpec).optional().describe("<seat>=<transcript .jsonl or directory> to add classifier denials the graph lacks") },
  flags: { transcript: { long: "--transcript", description: "<seat>=<path> seat transcript file or directory (repeatable)" } },
  schema: toolErrorsSchema,
  cliOnly: ["transcript"],
  async answer(db, report, options) {
    const data = await answerToolErrors(db, report, options.transcript ?? []);
    return { data, text: renderToolErrorsText(data) };
  },
});
