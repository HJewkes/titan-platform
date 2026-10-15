import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isFullSha } from "@titan-design/evidence";
import { diag, type GatherDiagnostic } from "./diagnostics.js";
import { digestFacts } from "./digest-facts.js";
import { ExplainerFactSchema, ReviewBundleSchema, type ExplainerFact, type FactSource, type ReviewBundle } from "./schemas.js";
import { entryPointFacts, readCoverage, readPin, summaryFacts, type FactOptions } from "./summary-facts.js";
import { claimFacts, ledgerFacts, topicFacts } from "./tsv-facts.js";

/** Stand-in for TP-2746's type profiles: only a repo argument needs a pain fact (decision 326). */
export type GatherProfile = "repo-tour" | "repo-argument";

export interface GatherOptions {
  reviewDir: string;
  clonePath: string;
  profile?: GatherProfile;
  /** Clone HEAD; injected so tests never spawn git. */
  readHead?: (clonePath: string) => Promise<string>;
}

export type GatherResult =
  | { ok: true; bundle: ReviewBundle; facts: ExplainerFact[]; diagnostics: GatherDiagnostic[] }
  | { ok: false; diagnostics: GatherDiagnostic[] };

type License = ReviewBundle["licenses"][number];
type Coverage = ReviewBundle["coverage"];

const FILES = {
  label: "synthesis/current-label",
  readme: "README.md",
  summary: "SUMMARY.md",
  licenses: "licenses.tsv",
  topics: "synthesis/final/topics-judged.tsv",
  ledger: "ledger.tsv",
  claims: "synthesis/final/claims-audit.tsv",
  digests: "digests",
} as const;

const PERMISSIVE = new Set(["MIT", "Apache-2.0", "ISC", "CC0-1.0", "0BSD"]);
const ROOT_PREFIX = "(root)";
// Tour sections a script cannot open without; the other SUMMARY sections only thin the tour.
const TOUR_REQUIRED = new Set(["what-it-is", "read-first"]);

const execFileAsync = promisify(execFile);

/** `git rev-parse HEAD` in the clone. */
export async function gitHead(clonePath: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", clonePath, "rev-parse", "HEAD"]);
  return stdout.trim();
}

interface ReviewReader {
  read(path: string): Promise<string | undefined>;
  list(dir: string): Promise<string[]>;
  hashes: Record<string, string>;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

// Every file read is hashed, so a bundle names exactly the review state its facts came from.
function reviewReader(reviewDir: string): ReviewReader {
  const hashes: Record<string, string> = {};
  return {
    hashes,
    async read(path) {
      try {
        const bytes = await readFile(join(reviewDir, path));
        hashes[path] = createHash("sha256").update(bytes).digest("hex");
        return bytes.toString("utf8");
      } catch (error) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    },
    async list(dir) {
      try {
        return (await readdir(join(reviewDir, dir))).sort();
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
    },
  };
}

/** `licenses.tsv` rows as `{prefix, license}`, header skipped. */
export function parseLicenses(text: string): License[] {
  return text
    .replace(/\r/g, "")
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t"))
    .filter(([prefix, license]) => prefix !== undefined && prefix !== "" && license !== undefined && license !== "")
    .map(([prefix, license]) => ({ prefix: prefix!, license: license!.trim() }));
}

function isPermissive(license: string): boolean {
  return PERMISSIVE.has(license) || license.startsWith("BSD-");
}

/** A path takes the license of its longest matching prefix, else the root license; no license is not safe. */
export function licenseCheck(licenses: License[]): (path: string) => boolean {
  const root = licenses.find((entry) => entry.prefix === ROOT_PREFIX);
  return (path) => {
    let best: License | undefined;
    for (const entry of licenses) {
      if (entry.prefix === ROOT_PREFIX || !path.startsWith(entry.prefix)) continue;
      if (best === undefined || entry.prefix.length > best.prefix.length) best = entry;
    }
    const license = (best ?? root)?.license;
    return license !== undefined && isPermissive(license);
  };
}

function checkLabel(label: string | undefined): GatherDiagnostic[] {
  const value = label?.trim();
  if (value === "final") return [];
  const why = value === undefined ? "is absent" : `is "${value}"`;
  return [diag("E-LABEL", `${FILES.label} ${why}; gather reads only a final synthesis`, FILES.label)];
}

function checkCoverage(summary: string | undefined, out: GatherDiagnostic[]): Coverage | undefined {
  const coverage = summary === undefined ? undefined : readCoverage(summary);
  if (coverage === undefined) {
    out.push(diag("E-UNREAD", `${FILES.summary} has no coverage line with unread=N`, FILES.summary));
  } else if (coverage.unread > 0) {
    out.push(diag("E-UNREAD", `coverage reports unread=${coverage.unread}; every file must be read first`, FILES.summary));
  }
  return coverage;
}

interface PinCheck {
  readme: string | undefined;
  clonePath: string;
  readHead: (clonePath: string) => Promise<string>;
}

async function checkPin({ readme, clonePath, readHead }: PinCheck, out: GatherDiagnostic[]) {
  const pin = readme === undefined ? undefined : readPin(readme);
  const url = readme === undefined ? undefined : /^[-*\s]*Remote:\s*(\S+)/m.exec(readme)?.[1];
  if (pin === undefined || !isFullSha(pin)) out.push(diag("E-PIN-UNKNOWN", `${FILES.readme} has no "HEAD: <40-hex>" pin`, FILES.readme));
  if (url === undefined) out.push(diag("E-PIN-UNKNOWN", `${FILES.readme} has no "Remote: <url>" line`, FILES.readme));
  let head: string | undefined;
  try {
    head = await readHead(clonePath);
  } catch (error) {
    out.push(diag("E-CLONE", `cannot read HEAD of ${clonePath}: ${error instanceof Error ? error.message : String(error)}`, clonePath));
  }
  if (head !== undefined && pin !== undefined && head !== pin) {
    out.push(diag("E-PIN", `clone HEAD ${head} is not the review pin ${pin}`, clonePath));
  }
  return pin === undefined || url === undefined ? undefined : { url, sha: pin, clone: clonePath };
}

interface FactContext {
  reader: ReviewReader;
  summary: string | undefined;
  readme: string | undefined;
  profile: GatherProfile;
  options: FactOptions;
}

type Parsed = { facts: ExplainerFact[]; diagnostics: GatherDiagnostic[] };

async function tsvFacts(reader: ReviewReader, out: GatherDiagnostic[]): Promise<ExplainerFact[]> {
  const sources: [string, (text: string) => Parsed, boolean][] = [
    [FILES.topics, topicFacts, true],
    [FILES.ledger, ledgerFacts, false],
    [FILES.claims, claimFacts, false],
  ];
  const facts: ExplainerFact[] = [];
  for (const [file, parse, required] of sources) {
    const text = await reader.read(file);
    if (text === undefined) {
      out.push(required ? diag("E-TOPICS", `${file} is absent`, file) : diag("W-SECTION", `${file} is absent; no facts from it`, file));
      continue;
    }
    const parsed = parse(text);
    facts.push(...parsed.facts);
    out.push(...parsed.diagnostics);
  }
  return facts;
}

function tourFacts({ summary, readme, profile, options }: FactContext, out: GatherDiagnostic[]): ExplainerFact[] {
  const { facts, missing } = summaryFacts(summary ?? "", options);
  for (const section of missing) {
    const code = profile === "repo-tour" && TOUR_REQUIRED.has(section) ? "E-SECTION" : "W-SECTION";
    out.push(diag(code, `${FILES.summary} has no "${section}" section`, FILES.summary));
  }
  const entries = entryPointFacts(readme ?? "", options);
  if (entries.length === 0) out.push(diag("W-NO-ENTRY", `${FILES.readme} has no entry-points block`, FILES.readme));
  return [...facts, ...entries];
}

async function shapeFacts({ reader, options }: FactContext, out: GatherDiagnostic[]): Promise<ExplainerFact[]> {
  const facts: ExplainerFact[] = [];
  for (const name of (await reader.list(FILES.digests)).filter((file) => file.endsWith(".json"))) {
    const text = (await reader.read(`${FILES.digests}/${name}`))!;
    const parsed = digestFacts(name.slice(0, -".json".length), text, options);
    facts.push(...parsed.facts);
    out.push(...parsed.diagnostics);
  }
  return facts;
}

// A parser that emits a fact the schema rejects loses that fact, not the gather.
function validFacts(facts: ExplainerFact[], out: GatherDiagnostic[]): ExplainerFact[] {
  return facts.filter((fact) => {
    const parsed = ExplainerFactSchema.safeParse(fact);
    if (!parsed.success) out.push(diag("W-BAD-ROW", `fact ${fact.id} fails the schema: ${parsed.error.message}`, fact.id));
    return parsed.success;
  });
}

async function gatherFacts(context: FactContext, out: GatherDiagnostic[]): Promise<ExplainerFact[]> {
  const facts = [...(await tsvFacts(context.reader, out)), ...tourFacts(context, out), ...(await shapeFacts(context, out))];
  if (context.profile === "repo-argument" && !facts.some((fact) => fact.kind === "pain")) {
    out.push(diag("W-NO-PAIN", "no pain fact from the README, issues or discussions; open on a demonstrable anomaly instead"));
  }
  return validFacts(facts, out);
}

function countBySource(facts: ExplainerFact[]): Partial<Record<FactSource, number>> {
  const counts: Partial<Record<FactSource, number>> = {};
  for (const fact of facts) counts[fact.source] = (counts[fact.source] ?? 0) + 1;
  return counts;
}

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Reads a finished repo review into a `review-bundle/v1` and its facts. Every precondition runs
 * before deciding, so one refusal lists everything the operator must fix; any error means no bundle.
 */
export async function gatherReview(options: GatherOptions): Promise<GatherResult> {
  const profile = options.profile ?? "repo-tour";
  const reader = reviewReader(options.reviewDir);
  const [label, readme, summary, licensesText] = await Promise.all(
    [FILES.label, FILES.readme, FILES.summary, FILES.licenses].map((file) => reader.read(file)),
  );
  const diagnostics = checkLabel(label);
  const coverage = checkCoverage(summary, diagnostics);
  const repo = await checkPin({ readme, clonePath: options.clonePath, readHead: options.readHead ?? gitHead }, diagnostics);
  if (licensesText === undefined) diagnostics.push(diag("W-SECTION", `${FILES.licenses} is absent; every cited path reads as unlicensed`, FILES.licenses));
  const licenses = parseLicenses(licensesText ?? "");
  const factOptions = { isLicenseSafe: licenseCheck(licenses) };
  const facts = await gatherFacts({ reader, summary, readme, profile, options: factOptions }, diagnostics);
  if (diagnostics.some((finding) => finding.severity === "error") || repo === undefined || coverage === undefined) {
    return { ok: false, diagnostics };
  }
  const bundle = ReviewBundleSchema.parse({
    schema: "review-bundle/v1",
    repo,
    label: label!.trim(),
    coverage,
    licenses,
    files_sha256: sortedRecord(reader.hashes),
    counts: countBySource(facts),
  });
  return { ok: true, bundle, facts, diagnostics };
}
