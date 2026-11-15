import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_GROUP_THRESHOLD, type MemoryFactType, type ParseFailure } from "@titan-design/memory";
import { defineCommand, EXIT } from "@titan-design/registry";
import { claudeTranscriptRoots, expandHome } from "@titan-design/session-read";
import { z } from "zod";
import type { MinerContext } from "../context.js";
import { scanMemory, type MemoryScan } from "../memory/discover.js";
import { checkIndex, type IndexCheck } from "../memory/index-check.js";
import { instructionFacts, scanInstructions } from "../memory/instructions.js";
import { buildMemoryReport, writeMemoryReport, type MemoryReport } from "../memory/report.js";
import { defaultSkillsRoots, readSkills } from "../memory/skills.js";

interface Unparsed {
  path: string;
  error: string;
}

interface IndexFinding extends IndexCheck {
  index: string;
}

interface IndexSummary {
  checked: number;
  dangling: number;
  unindexed: number;
  unloaded: number;
  findings: IndexFinding[];
}

interface MemoryScanResult {
  files: number;
  indexes: number;
  index: IndexSummary;
  byAccount: Record<string, number>;
  byType: Partial<Record<MemoryFactType, number>>;
  unparsed: Unparsed[];
}

interface MemoryReportResult {
  reportId: string;
  dir: string;
  report: string;
  decisions: string;
  files: number;
  skillsIndexed: number;
  instructionSections: number;
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

function checkIndexFile(indexPath: string): IndexFinding | undefined {
  try {
    const dir = path.dirname(indexPath);
    const check = checkIndex(readFileSync(indexPath, "utf8"), readdirSync(dir).filter((name) => name.endsWith(".md")));
    return { index: indexPath, ...check, unindexed: check.unindexed.map((name) => path.join(dir, name)) };
  } catch {
    return undefined;
  }
}

// Paths and line numbers only: an index's prose never leaves the machine.
function summarizeIndexes(indexes: readonly string[]): IndexSummary {
  const findings = indexes.map(checkIndexFile).filter((finding): finding is IndexFinding => finding !== undefined);
  const sum = (pick: (finding: IndexFinding) => number): number => findings.reduce((total, finding) => total + pick(finding), 0);
  return {
    checked: findings.length,
    dangling: sum((finding) => finding.dangling.length),
    unindexed: sum((finding) => finding.unindexed.length),
    unloaded: sum((finding) => finding.unloaded.length),
    findings: findings.filter((finding) => finding.dangling.length + finding.unindexed.length + finding.unloaded.length > 0),
  };
}

function summarizeScan(scan: MemoryScan): MemoryScanResult {
  return {
    files: scan.facts.length + scan.unparsed.length,
    indexes: scan.indexes.length,
    index: summarizeIndexes(scan.indexes),
    byAccount: tally([...scan.facts, ...scan.unparsed].map(({ ref }) => ref.account)),
    byType: tally(scan.facts.map((fact) => fact.type)),
    unparsed: unparsedOf(scan.unparsed),
  };
}

// Group stats and paths only: fact text never leaves the machine through MCP or HTTP.
function summarizeReport(scan: MemoryScan, report: MemoryReport, skillsIndexed: number): Omit<MemoryReportResult, "dir" | "report" | "decisions" | "instructionSections"> {
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
  groupThreshold: z.number().min(0).max(1).default(DEFAULT_GROUP_THRESHOLD).describe("average topic similarity (TF-IDF cosine) at which two groups merge"),
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
      groupThreshold: { long: "--group-threshold", description: `average topic similarity (TF-IDF cosine) at which two groups merge (default ${DEFAULT_GROUP_THRESHOLD})` },
    },
  },
  async run(args, ctx) {
    refuseOffCli([...(args.skillsRoot.length > 0 ? ["--skills-root"] : []), ...(args.out ? ["--out"] : [])], ctx);
    const scan = scanMemory();
    const instructions = instructionFacts(scanInstructions(claudeTranscriptRoots()));
    const skills = readSkills(args.skillsRoot.length > 0 ? args.skillsRoot.map((root) => expandHome(root)) : defaultSkillsRoots());
    const report = buildMemoryReport([...scan.facts, ...instructions], skills, new Date(), args.groupThreshold);
    const written = writeMemoryReport(args.out ? expandHome(args.out) : path.join(ctx.config.stateDir, "memory-miner"), report);
    return { ...summarizeReport(scan, report, skills.length), instructionSections: instructions.length, ...written };
  },
});
