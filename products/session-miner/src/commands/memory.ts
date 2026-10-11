import path from "node:path";
import type { MemoryFactType, ParseFailure } from "@titan-design/memory";
import { defineCommand, EXIT } from "@titan-design/registry";
import { expandHome } from "@titan-design/session-read";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { scanMemory, type MemoryScan } from "../memory/discover.js";
import { buildMemoryReport, DEFAULT_GROUP_THRESHOLD, writeMemoryReport, type MemoryReport } from "../memory/report.js";
import { defaultSkillsRoots, readSkills } from "../memory/skills.js";

export interface Unparsed {
  path: string;
  error: string;
}

export interface MemoryScanResult {
  files: number;
  indexes: number;
  byAccount: Record<string, number>;
  byType: Partial<Record<MemoryFactType, number>>;
  unparsed: Unparsed[];
}

export interface MemoryReportResult {
  reportId: string;
  dir: string;
  report: string;
  decisions: string;
  files: number;
  skillsIndexed: number;
  groups: number;
  singletons: number;
  largestGroup: number;
  byDestination: Record<string, number>;
  unparsed: Unparsed[];
}

function tally(keys: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
}

const unparsedOf = (failures: readonly ParseFailure[]): Unparsed[] => failures.map(({ ref, error }) => ({ path: ref.path, error }));

function summarizeScan(scan: MemoryScan): MemoryScanResult {
  return {
    files: scan.facts.length + scan.unparsed.length,
    indexes: scan.indexes.length,
    byAccount: tally([...scan.facts, ...scan.unparsed].map(({ ref }) => ref.account)),
    byType: tally(scan.facts.map((fact) => fact.type)),
    unparsed: unparsedOf(scan.unparsed),
  };
}

// Group stats and paths only: fact text never leaves the machine through MCP or HTTP.
function summarizeReport(scan: MemoryScan, report: MemoryReport, skillsIndexed: number): Omit<MemoryReportResult, "dir" | "report" | "decisions"> {
  const sizes = report.groups.map((group) => group.facts.length);
  return {
    reportId: report.reportId,
    files: scan.facts.length + scan.unparsed.length,
    skillsIndexed,
    groups: sizes.length,
    singletons: sizes.filter((size) => size === 1).length,
    largestGroup: Math.max(0, ...sizes),
    byDestination: tally(report.groups.map((group) => group.destination.split(":")[0] ?? group.destination)),
    unparsed: unparsedOf(scan.unparsed),
  };
}

function refuseOffCli(given: readonly string[], ctx: MinerContext): void {
  if (given.length > 0 && ctx.surface !== "cli") throw Object.assign(new Error(`${given.join(", ")} is accepted only on the CLI`), { code: EXIT.DATAERR });
}

export const memoryScan = defineCommand<Record<string, never>, MemoryScanResult, MinerContext>({
  name: "memory.scan",
  description: "Count every Claude Code auto-memory fact file, by account and type, and list the ones that do not parse",
  args: z.object({}),
  result: z.custom<MemoryScanResult>(),
  async run() {
    return summarizeScan(scanMemory());
  },
});

const ReportArgs = z.object({
  skillsRoot: z.array(z.string()).default([]).describe("skills directory to match groups against (repeatable; CLI only)"),
  out: z.string().optional().describe("directory to write the report under (CLI only)"),
  groupThreshold: z.number().min(0).max(1).default(DEFAULT_GROUP_THRESHOLD).describe("topic Jaccard at which two facts share a group"),
});

export const memoryReport = defineCommand<z.infer<typeof ReportArgs>, MemoryReportResult, MinerContext>({
  name: "memory.report",
  description: "Dedupe and group auto-memory facts, propose a destination per group, and write report.md and decisions.yml for review",
  args: ReportArgs,
  result: z.custom<MemoryReportResult>(),
  cli: {
    options: {
      skillsRoot: { long: "--skills-root", description: "skills directory (repeatable; default ~/.claude/skills)" },
      out: { long: "--out", description: "report directory (default <state>/memory-miner)" },
      groupThreshold: { long: "--group-threshold", description: `topic Jaccard that links two facts (default ${DEFAULT_GROUP_THRESHOLD})` },
    },
  },
  async run(args, ctx) {
    refuseOffCli([...(args.skillsRoot.length > 0 ? ["--skills-root"] : []), ...(args.out ? ["--out"] : [])], ctx);
    const scan = scanMemory();
    const skills = readSkills(args.skillsRoot.length > 0 ? args.skillsRoot.map(expandHome) : defaultSkillsRoots());
    const report = buildMemoryReport(scan.facts, skills, new Date(), args.groupThreshold);
    const written = writeMemoryReport(args.out ? expandHome(args.out) : path.join(ctx.config.stateDir, "memory-miner"), report);
    return { ...summarizeReport(scan, report, skills.length), ...written };
  },
});
