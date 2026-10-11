import { EXIT } from "@titan-design/registry";
import { LIST_PRICE_CAVEAT, scopeFilter, type CostReportOptions } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { ADOPTION_OPPORTUNITIES, type AdoptionOpportunity } from "./adoption-registry.js";
import { defineInsight } from "./define.js";
import { ourPipelines, patternId, type PostFilterUse } from "./post-filter.js";
import { readBashCalls, readBashCommand, readCommands, type BashCall, type TimedBashCall } from "./tool-gaps-sources.js";

/** Where the question reads what agents ran and what time it is; tests inject both. */
export interface ToolAdoptionPorts {
  command(call: BashCall): Promise<string | null>;
  now(): Date;
}

export const ADOPTION_FLAGS = ["unadopted", "unused"] as const;

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** How long a new form has to take over before the report judges it. */
const GRACE_MS = 14 * DAY_MS;
/** How far back the window reaches when no entry has shipped and no `--since` was given. */
const BASELINE_MS = 28 * DAY_MS;

const count = z.number().int();
const weekRow = z.object({ week: count, start: z.string(), newUses: count, oldUses: count });
const opportunityRow = z.object({
  id: z.string(),
  row: count,
  status: z.enum(["shipped", "baseline"]),
  task: z.string().nullable(),
  pr: z.string().nullable(),
  shipped: z.string().nullable(),
  newForm: z.string(),
  oldHead: z.string(),
  oldPatterns: z.array(z.object({ pattern: z.string(), patternId: z.string() })),
  newUses: count,
  oldUses: count,
  weeks: z.array(weekRow),
  daysSinceShip: count.nullable(),
  watching: z.boolean(),
  flags: z.array(z.enum(ADOPTION_FLAGS)),
  note: z.string().nullable(),
});

export const toolAdoptionSchema = z.object({
  window: z.object({ since: z.string(), until: z.string() }),
  totals: z.object({ bashCalls: count, skippedByHeads: count, unreadable: count, opportunities: count }),
  opportunities: z.array(opportunityRow),
});

export type ToolAdoptionReport = z.infer<typeof toolAdoptionSchema>;
export type AdoptionRow = z.infer<typeof opportunityRow>;
type Form = "new" | "old";

interface TimedPipeline {
  use: PostFilterUse;
  at: number;
}

/**
 * Which form of the opportunity a pipeline is, if either; passing a new flag wins over still piping through an old filter.
 * A new form on the old head with no flags is never counted, since every old pipeline would match it.
 */
export function adoptionForm(opportunity: AdoptionOpportunity, use: PostFilterUse): Form | null {
  const { old, new: next } = opportunity;
  const newVerb = next.flags.length === 0 && next.head !== old.head;
  if (use.head === next.head && (newVerb || next.flags.some((flag) => use.headFlags.includes(flag)))) return "new";
  if (use.head === old.head && old.patterns.includes(use.pattern)) return "old";
  return null;
}

/** Every pipeline headed by our CLIs; a call whose recorded heads name none of the tracked programs is never read back. */
async function readPipelines(calls: readonly TimedBashCall[], registry: readonly AdoptionOpportunity[], command: ToolAdoptionPorts["command"]) {
  const programs = [...new Set(registry.flatMap((o) => [o.old.head, o.new.head].map((head) => head.split(" ")[0]!)))];
  const candidates = calls.filter((c) => c.heads === null || programs.some((p) => c.heads!.includes(p)));
  const read = await readCommands(candidates, command);
  const pipelines = read.flatMap(({ call, text }) => (text === null ? [] : ourPipelines(text).map((use): TimedPipeline => ({ use, at: Date.parse(call.ts) }))));
  return { pipelines, unreadable: read.filter((r) => r.text === null).length, skippedByHeads: calls.length - candidates.length };
}

interface Use {
  form: Form;
  at: number;
}

const tally = (uses: readonly Use[], form: Form) => uses.filter((u) => u.form === form).length;
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Each week from `from` (ship, or the window start for a baseline) to `asOf`, the last one partial; weeks that end before `since` are left out, since nothing was read for them. */
function weeklyUses(from: number, since: number, asOf: number, uses: readonly Use[]): AdoptionRow["weeks"] {
  const weeks = Math.max(0, Math.ceil((asOf - from) / WEEK_MS));
  return Array.from({ length: weeks }, (_, i) => from + i * WEEK_MS)
    .filter((start) => start + WEEK_MS > since)
    .map((start) => {
      const inWeek = uses.filter((u) => u.at >= start && u.at < start + WEEK_MS);
      return { week: Math.round((start - from) / WEEK_MS) + 1, start: isoDate(start), newUses: tally(inWeek, "new"), oldUses: tally(inWeek, "old") };
    });
}

/** Judged only from two weeks after ship: unadopted while the old patterns outnumber the new form, unused while nobody ran it. */
function adoptionFlags(shipped: number, uses: readonly Use[]): AdoptionRow["flags"] {
  const ripe = uses.filter((u) => u.at >= shipped + GRACE_MS);
  return [...(tally(ripe, "old") > tally(ripe, "new") ? (["unadopted"] as const) : []), ...(tally(uses, "new") === 0 ? (["unused"] as const) : [])];
}

/** Uses of either form from `from` on; a baseline counts only the old pipelines, since its new form does not exist yet. */
function usesFrom(o: AdoptionOpportunity, pipelines: readonly TimedPipeline[], from: number): Use[] {
  return pipelines.flatMap(({ use, at }): Use[] => {
    const form = at >= from ? adoptionForm(o, use) : null;
    return form && (o.status === "shipped" || form === "old") ? [{ form, at }] : [];
  });
}

function opportunityReport(o: AdoptionOpportunity, pipelines: readonly TimedPipeline[], since: number, asOf: number): AdoptionRow {
  const from = o.status === "shipped" ? Date.parse(o.shipped) : since;
  const uses = usesFrom(o, pipelines, from);
  const watching = o.status === "shipped" && asOf - from < GRACE_MS;
  return {
    id: o.id,
    row: o.row,
    status: o.status,
    task: o.task,
    pr: o.status === "shipped" ? o.pr : null,
    shipped: o.status === "shipped" ? o.shipped : null,
    newForm: [o.new.head, o.new.flags.join(" or ")].filter(Boolean).join(" "),
    oldHead: o.old.head,
    oldPatterns: o.old.patterns.map((pattern) => ({ pattern, patternId: patternId(pattern) })),
    newUses: tally(uses, "new"),
    oldUses: tally(uses, "old"),
    weeks: weeklyUses(from, since, asOf, uses),
    daysSinceShip: o.status === "shipped" ? Math.floor((asOf - from) / DAY_MS) : null,
    watching,
    flags: watching || o.status === "baseline" ? [] : adoptionFlags(from, uses),
    note: o.note ?? null,
  };
}

/** The earliest ship, else four weeks before `now`, so a registry of baselines alone still reads a window. */
function defaultSince(registry: readonly AdoptionOpportunity[], now: Date): string {
  const ships = registry.flatMap((o) => (o.status === "shipped" ? [o.shipped] : []));
  return ships.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? new Date(now.getTime() - BASELINE_MS).toISOString();
}

export async function toolAdoptionReport(db: Db, report: CostReportOptions, ports: ToolAdoptionPorts, registry: readonly AdoptionOpportunity[]): Promise<ToolAdoptionReport> {
  const since = report.since ?? defaultSince(registry, ports.now());
  const until = report.until ?? ports.now().toISOString();
  const inScope = scopeFilter(db, report.scope);
  const calls = readBashCalls(db, { since, until: report.until }).filter((c) => inScope({ sessionId: c.sessionId, role: "" }));
  const { pipelines, unreadable, skippedByHeads } = await readPipelines(calls, registry, ports.command);
  return {
    window: { since, until },
    totals: { bashCalls: calls.length, skippedByHeads, unreadable, opportunities: registry.length },
    opportunities: registry.map((o) => opportunityReport(o, pipelines, Date.parse(since), Date.parse(until))),
  };
}

const cell = (value: string | number) => String(value).replaceAll("|", "\\|");

function verdict(row: AdoptionRow): string {
  if (row.status === "baseline") return "baseline";
  if (row.watching) return "watching";
  return row.flags.length > 0 ? row.flags.join(" ") : "none";
}

export function renderToolAdoptionText(data: ToolAdoptionReport): string {
  const { totals, window } = data;
  const header = [
    `Tool adoption: flags and verbs against the pipelines they replace, ${window.since} to ${window.until}`,
    `${totals.opportunities} opportunities, from ${totals.bashCalls} Bash calls (${totals.skippedByHeads} ruled out by recorded heads, ${totals.unreadable} unreadable).`,
    "Weekly new/old: uses of the new form and of the old patterns in each week since ship. Old patterns are Q9 pattern ids.",
    "unadopted: from two weeks after ship the old patterns still outnumber the new form. unused: nobody ran the new form. watching: shipped under two weeks ago.",
    "baseline: not shipped yet; weekly counts run from the window start and hold the old patterns only.",
  ].join("\n");
  const rows = data.opportunities.map((r) => {
    const weekly = r.weeks.map((w) => `${w.newUses}/${w.oldUses}`).join(" ");
    const cells = [r.id, r.pr ?? "-", r.shipped?.slice(0, 10) ?? "-", r.newForm, r.oldPatterns.map((p) => p.patternId).join(" "), weekly, r.newUses, r.oldUses, verdict(r)];
    return `| ${cells.map(cell).join(" | ")} |`;
  });
  const table = ["| id | pr | shipped | new form | old patterns | weekly new/old | new | old | flags |", "|---|---|---|---|---|---|---:|---:|---|", ...rows];
  return [header, table.join("\n"), LIST_PRICE_CAVEAT].join("\n\n") + "\n";
}

export const DEFAULT_TOOL_ADOPTION_PORTS: ToolAdoptionPorts = { command: (call) => readBashCommand(call), now: () => new Date() };

export function toolAdoptionQuestion(ports: ToolAdoptionPorts = DEFAULT_TOOL_ADOPTION_PORTS, registry: readonly AdoptionOpportunity[] = ADOPTION_OPPORTUNITIES) {
  return defineInsight<Record<never, never>, ToolAdoptionReport>({
    id: "Q10",
    name: "tool-adoption",
    description: "Per flag or verb in the adoption registry, weekly uses of the new form against the old pipelines it replaces, flagged unadopted or unused two weeks after ship; an unshipped baseline counts the old pipelines alone",
    options: {},
    flags: {},
    schema: toolAdoptionSchema,
    async answer(db, report) {
      if (report.scope?.roles !== undefined) throw Object.assign(new Error("tool-adoption does not take role; narrow it with --session or --agent-prefix"), { code: EXIT.DATAERR });
      const data = await toolAdoptionReport(db, report, ports, registry);
      return { data, text: renderToolAdoptionText(data) };
    },
  });
}

export const toolAdoption = toolAdoptionQuestion();
