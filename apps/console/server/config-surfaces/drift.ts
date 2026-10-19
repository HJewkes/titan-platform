/**
 * Table 1.6 of the TP-3579 plan: one value kept in several files. Each duplicate becomes one row
 * listing every copy this host holds, and the row is drift when any two copies disagree. Every
 * copy is compared, not just a pair, so a third file that moved alone still shows.
 */
import { z } from "zod";
import { readCommand } from "../owner-guard.js";
import { joinSurfaces, type ConfigRow, type ConfigSurfaces, type SurfaceReader } from "./catalog.js";

const copyRef = z.object({ surface: z.string(), field: z.string() });
const driftSource = copyRef.extend({ file: z.string(), line: z.number().int(), value: z.unknown() });

const duplicateRow = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(["drift", "agree"]),
  /** Each distinct value once, in the order the copies list them. */
  values: z.array(z.unknown()),
  sources: z.array(driftSource),
  /** Copies the table names that this host lacks or keeps hidden. */
  absent: z.array(copyRef),
});

const driftResult = z.object({ rows: z.array(duplicateRow), gaps: z.array(z.string()) });

export type DuplicateRow = z.infer<typeof duplicateRow>;
type CopyRef = z.infer<typeof copyRef>;

interface Duplicate {
  id: string;
  label: string;
  copies: readonly CopyRef[];
}

const FIXED_DUPLICATES: readonly Duplicate[] = [
  {
    id: "worktrees-per-repo",
    label: "Worktree cap per repo",
    copies: [
      { surface: "claude-md", field: "worktreesPerRepo" },
      { surface: "charter", field: "defaults.worktrees_per_repo_per_seat" },
      { surface: "agent-chat-config", field: "worktreeBudget" },
      { surface: "burndown", field: "maxWorktreesPerRepo" },
    ],
  },
  {
    id: "load-hold",
    label: "Load hold (load5)",
    copies: [
      { surface: "agent-chat-config", field: "machineStopLoad5" },
      { surface: "factory-config", field: "shepherd.spawnGate.load5" },
    ],
  },
];

const shownRow = (rows: readonly ConfigRow[], { surface, field }: CopyRef): ConfigRow | undefined =>
  rows.find((row) => row.surface === surface && row.field === field && !row.hidden);

/** `maxAgents` caps the whole tick, so it duplicates a seat's implementer cap only while the roster names that seat alone. */
function rosterDuplicates(rows: readonly ConfigRow[]): Duplicate[] {
  const roster = shownRow(rows, { surface: "burndown", field: "seats" })?.value;
  if (!Array.isArray(roster) || roster.length !== 1 || typeof roster[0] !== "string") return [];
  const seat = roster[0];
  return [
    {
      id: `implementers:${seat}`,
      label: `${seat} implementer cap`,
      copies: [
        { surface: `seat:${seat}`, field: "concurrency.implementers" },
        { surface: "burndown", field: "maxAgents" },
      ],
    },
  ];
}

function distinctValues(values: readonly unknown[]): unknown[] {
  const seen = new Map<string, unknown>();
  for (const value of values) if (!seen.has(JSON.stringify(value))) seen.set(JSON.stringify(value), value);
  return [...seen.values()];
}

/** One copy alone is not a duplicate, so a value found in fewer than two files makes no row. */
function compare(duplicate: Duplicate, rows: readonly ConfigRow[]): DuplicateRow | null {
  const found = duplicate.copies.map((copy) => ({ copy, row: shownRow(rows, copy) }));
  const sources = found.flatMap(({ row }) => (row === undefined ? [] : [{ surface: row.surface, field: row.field, file: row.file, line: row.line, value: row.value }]));
  if (sources.length < 2) return null;
  const values = distinctValues(sources.map((source) => source.value));
  const absent = found.filter(({ row }) => row === undefined).map(({ copy }) => copy);
  return { id: duplicate.id, label: duplicate.label, status: values.length > 1 ? "drift" : "agree", values, sources, absent };
}

/** Drift rows first, so the page can lead with them; agreeing duplicates follow as edit points to keep in step. */
export function deriveDrift(surfaces: ConfigSurfaces): DuplicateRow[] {
  const duplicates = [...FIXED_DUPLICATES, ...rosterDuplicates(surfaces.rows)];
  const rows = duplicates.flatMap((duplicate) => compare(duplicate, surfaces.rows) ?? []);
  return [...rows.filter((row) => row.status === "drift"), ...rows.filter((row) => row.status === "agree")];
}

export function configDriftCommands(readers: readonly SurfaceReader[]) {
  return {
    "config.drift": readCommand({
      name: "config.drift",
      description: "Each value kept in several config files, with every copy's file, line and value; a row is drift when any two copies disagree",
      args: z.object({}),
      result: driftResult,
      run: async () => {
        const surfaces = joinSurfaces(await Promise.all(readers.map((read) => read())));
        return { rows: deriveDrift(surfaces), gaps: surfaces.gaps };
      },
    }),
  };
}
