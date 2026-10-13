import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_GROUP_THRESHOLD, dedupeFacts, groupFacts, proposeDestination, type FactGroup, type MemoryDestination, type ParsedFact, type SkillSummary } from "@titan-design/memory";
import { stringify } from "yaml";

interface ReportSource {
  account: string;
  project: string;
  path: string;
  host?: string;
  contentHash: string;
}

interface ReportGroup {
  id: string;
  label: string;
  destination: MemoryDestination;
  reason: string;
  facts: ParsedFact[];
  sources: ReportSource[];
}

export interface MemoryReport {
  reportId: string;
  groups: ReportGroup[];
}

interface WrittenReport {
  dir: string;
  report: string;
  decisions: string;
}

function sourceOf({ ref, contentHash }: ParsedFact): ReportSource {
  return { account: ref.account, project: ref.project, path: ref.path, ...(ref.host ? { host: ref.host } : {}), contentHash };
}

function compactUtc(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** The UTC time plus a digest of every fact's content hash, so the same memory at the same instant gives the same id. */
function reportIdFor(facts: readonly ParsedFact[], now: Date): string {
  const digest = createHash("sha256").update(facts.map((fact) => fact.contentHash).sort().join("\n")).digest("hex");
  return `${compactUtc(now)}-${digest.slice(0, 8)}`;
}

function toReportGroup(group: FactGroup, index: number, skills: readonly SkillSummary[], now: Date): ReportGroup {
  const { destination, reason } = proposeDestination(group, skills, { now });
  return {
    id: `g${String(index + 1).padStart(3, "0")}`,
    label: group.label,
    destination,
    reason,
    facts: group.facts.map(({ fact }) => fact),
    sources: group.facts.flatMap(({ sources }) => sources.map(sourceOf)),
  };
}

export function buildMemoryReport(facts: readonly ParsedFact[], skills: readonly SkillSummary[], now: Date, threshold = DEFAULT_GROUP_THRESHOLD): MemoryReport {
  const groups = groupFacts(dedupeFacts(facts), { threshold });
  return { reportId: reportIdFor(facts, now), groups: groups.map((group, index) => toReportGroup(group, index, skills, now)) };
}

function renderFact(fact: ParsedFact): string {
  const body = fact.body.split("\n").map((line) => `> ${line}`).join("\n");
  return `#### ${fact.name} (${fact.type})\n\n${fact.description}\n\n${body}\n`;
}

function renderGroup(group: ReportGroup): string {
  const sources = group.sources.map((source) => `- ${source.account}/${source.project}${source.host ? ` on ${source.host}` : ""}: \`${source.path}\` (${source.contentHash.slice(0, 12)})`);
  return [
    `## ${group.id}: ${group.label}`,
    "",
    `Proposed destination: \`${group.destination}\`. ${group.reason}.`,
    "",
    "### Sources",
    "",
    ...sources,
    "",
    "### Facts",
    "",
    ...group.facts.map(renderFact),
  ].join("\n");
}

function renderReportMarkdown(report: MemoryReport): string {
  const intro = `# Memory report ${report.reportId}\n\n${report.groups.length} groups. Edit decisions.yml beside this file: set each group's decision to accept or reject, and change its destination if you want.\n`;
  return [intro, ...report.groups.map(renderGroup)].join("\n");
}

function renderDecisions(report: MemoryReport): string {
  const groups = report.groups.map(({ id, label, destination, reason, sources }) => ({ id, label, decision: "pending", destination, reason, sources }));
  return stringify({ reportId: report.reportId, groups });
}

// Memory bodies can hold anything the owner told an agent, so the report is readable by the owner alone.
export function writeMemoryReport(outRoot: string, report: MemoryReport): WrittenReport {
  const dir = path.join(outRoot, report.reportId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const written = { dir, report: path.join(dir, "report.md"), decisions: path.join(dir, "decisions.yml") };
  writeFileSync(written.report, renderReportMarkdown(report), { mode: 0o600 });
  writeFileSync(written.decisions, renderDecisions(report), { mode: 0o600 });
  return written;
}
