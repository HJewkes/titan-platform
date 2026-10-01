import type { Maturity, MaturityChange, PlaybookStore } from "@titan-design/memory";
import type { PrincipleFeedback } from "./feedback.js";
import type { LedgerRow } from "./ledger.js";
import { assertDomain, type Principle } from "./principles.js";

/** What one condensation run changed in a domain; every list holds principle ids. */
export interface DomainChanges {
  added: string[];
  promoted: string[];
  demoted: string[];
  retired: string[];
  confirmed: string[];
  contradicted: string[];
}

export interface RunChanges {
  added?: readonly string[];
  retired?: readonly string[];
  maturityChanges?: readonly MaturityChange[];
  feedback?: readonly PrincipleFeedback[];
}

const RANK: Record<Maturity, number> = { deprecated: 0, candidate: 1, established: 2, proven: 3 };
const CHANGE_LABELS: [keyof DomainChanges, string][] = [
  ["added", "added"],
  ["promoted", "promoted"],
  ["demoted", "demoted"],
  ["retired", "retired"],
  ["confirmed", "confirmed"],
  ["contradicted", "contradicted"],
];

function emptyChanges(): DomainChanges {
  return { added: [], promoted: [], demoted: [], retired: [], confirmed: [], contradicted: [] };
}

function maturityBucket(change: MaturityChange): keyof DomainChanges {
  if (change.to === "deprecated") return "retired";
  return RANK[change.to] > RANK[change.from] ? "promoted" : "demoted";
}

function runEntries(run: RunChanges): [string, keyof DomainChanges][] {
  return [
    ...(run.added ?? []).map((id): [string, keyof DomainChanges] => [id, "added"]),
    ...(run.retired ?? []).map((id): [string, keyof DomainChanges] => [id, "retired"]),
    ...(run.maturityChanges ?? []).map((c): [string, keyof DomainChanges] => [c.bulletId, maturityBucket(c)]),
    ...(run.feedback ?? []).map((f): [string, keyof DomainChanges] => [f.principleId, f.type === "helpful" ? "confirmed" : "contradicted"]),
  ];
}

/** Group a run's changes by the domain of each principle, retired ones included. */
export function changesByDomain(store: PlaybookStore, run: RunChanges): Map<string, DomainChanges> {
  const grouped = new Map<string, DomainChanges>();
  for (const [id, bucket] of runEntries(run)) {
    const domain = store.get(id)?.category;
    if (domain === undefined) continue;
    const changes = grouped.get(domain) ?? emptyChanges();
    if (!changes[bucket].includes(id)) changes[bucket].push(id);
    grouped.set(domain, changes);
  }
  return grouped;
}

/** A one-line quote for a cited example: the owner's answer, or the question when there is none. */
export function quoteOf(row: Pick<LedgerRow, "answer" | "question">, maxLength = 120): string {
  const line = (row.answer ?? row.question).split("\n").find((l) => l.trim().length > 0)?.trim() ?? "";
  return line.length > maxLength ? `${line.slice(0, maxLength - 3)}...` : line;
}

export interface RenderOptions {
  /** The quote for a ledger key; examples without one are listed by key alone. */
  quote?: (key: string) => string | undefined;
  /** Newest examples and counter-examples shown per principle. */
  maxExamples?: number;
}

function exampleLines(keys: readonly string[], options: RenderOptions): string[] {
  const shown = keys.slice(-(options.maxExamples ?? 5));
  if (shown.length === 0) return ["  - none"];
  return shown.map((key) => {
    const quote = options.quote?.(key);
    return quote === undefined ? `  - \`${key}\`` : `  - \`${key}\`: "${quote}"`;
  });
}

function principleSection(p: Principle, options: RenderOptions): string[] {
  return [
    `## ${p.id}`,
    "",
    `${p.isNegative ? "Avoid" : "Rule"}: ${p.rule}`,
    "",
    `- Confidence: ${p.maturity}, score ${p.score.toFixed(2)}`,
    `- Last confirmed: ${p.lastConfirmed?.slice(0, 10) ?? "never"}`,
    "- Examples:",
    ...exampleLines(p.examples, options),
    "- Counter-examples:",
    ...exampleLines(p.counterExamples, options),
    "",
  ];
}

function byConfidence(a: Principle, b: Principle): number {
  return RANK[b.maturity] - RANK[a.maturity] || b.score - a.score || a.id.localeCompare(b.id);
}

/** Everything above the changelog: the part a run recomputes from the playbook each time. */
export function renderBody(domain: string, principles: readonly Principle[], options: RenderOptions = {}): string {
  const live = [...principles].sort(byConfidence);
  return [
    `# Principles: ${domain}`,
    "",
    "A view of the decider playbook; the playbook is the source of truth.",
    "",
    ...(live.length === 0 ? ["No live principles.", ""] : live.flatMap((p) => principleSection(p, options))),
  ].join("\n");
}

/** One changelog line, or null when the run changed nothing in the domain. */
export function changelogEntry(version: number, date: string, changes: DomainChanges): string | null {
  const parts = CHANGE_LABELS.filter(([key]) => changes[key].length > 0).map(([key, label]) => `${label} ${changes[key].join(", ")}`);
  return parts.length === 0 ? null : `- v${version} (${date}): ${parts.join("; ")}`;
}

export interface PriorDoc {
  version: number;
  changelog: string[];
}

const CHANGELOG_HEADING = "## Changelog";

/** Read the version and changelog back out of a previously rendered doc. */
export function parsePriorDoc(markdown: string): PriorDoc | null {
  const version = /^version: (\d+)$/m.exec(markdown)?.[1];
  if (version === undefined) return null;
  const at = markdown.indexOf(`\n${CHANGELOG_HEADING}\n`);
  const tail = at < 0 ? "" : markdown.slice(at + CHANGELOG_HEADING.length + 2);
  return { version: Number(version), changelog: tail.split("\n").filter((l) => l.startsWith("- ")) };
}

export interface DomainDoc {
  domain: string;
  version: number;
  markdown: string;
  /** False when the run changed nothing here and the version stayed put. */
  bumped: boolean;
}

export interface DomainDocInput {
  domain: string;
  principles: readonly Principle[];
  changes: DomainChanges;
  prior: PriorDoc | null;
  now: Date;
}

/** Render one domain's doc; the version moves only when the run changed something in the domain. */
export function renderDomainDoc(input: DomainDocInput, options: RenderOptions = {}): DomainDoc {
  const domain = assertDomain(input.domain);
  const date = input.now.toISOString().slice(0, 10);
  const next = (input.prior?.version ?? 0) + 1;
  const entry = changelogEntry(next, date, input.changes) ?? (input.prior === null ? `- v1 (${date}): first render` : null);
  const version = entry === null ? (input.prior?.version ?? 1) : next;
  const changelog = [...(entry === null ? [] : [entry]), ...(input.prior?.changelog ?? [])];
  const markdown = [
    ["---", `domain: ${domain}`, `version: ${version}`, "---", ""].join("\n"),
    renderBody(domain, input.principles, options),
    [CHANGELOG_HEADING, "", ...changelog, ""].join("\n"),
  ].join("\n");
  return { domain, version, markdown, bumped: entry !== null };
}
