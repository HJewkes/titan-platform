/**
 * TP-4404: the console card for an owner-at-head merge gate (D21, TP-4141) is a projection of the merge evidence the gate was
 * opened on, never a read of its own. Its facts are recomputed from that evidence with land's own functions and must equal
 * the gate's marker; a CI-policy section is the evidence's own reading beside the verdict text it was read from; file
 * sections show the evidence's changed paths, each pinned by blob sha and shown exactly (exact-file.ts). Anything the card
 * cannot show from that object reads as missing, and the gate stays on the terminal.
 */
import { isDeepStrictEqual } from "node:util";
import type { GitHubPort } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import { ciPolicyLabelledLines, parseVerdictBlock, readClaudeText, readCodexText, type CiPolicy, type CiPolicyLabelledLine, type SourceTextLocator } from "@titan-design/session-read";
import { landGate, ownerAtHeadRow, type LandGate } from "../coordinator-evidence.js";
import type { FactoryHost } from "../host.js";
import { ownerAtHeadNamesIn, type OwnerAtHeadRow } from "../owner-at-head.js";
import { MAX_LINES_PER_CARD, MAX_LINES_PER_FILE } from "../shepherd/ci-policy-changes.js";
import { isGithubPath } from "../shepherd/ci-policy-read.js";
import { MERGE_EVIDENCE_STEP, type MergeEvidence } from "../shepherd/merge-facts.js";
import type { Verdict } from "../shepherd/phases.js";
import { mergeEvidenceAt, ownerAtHeadAt, skillPathsAt } from "../shepherd/policy.js";
import { MergeEvidenceSchema } from "../shepherd/review-schemas.js";
import { skillPathsIn } from "../shepherd/skill-paths.js";
import { ownerAtHeadRows } from "../workflows/land-approval.js";
import { exactFile, type ExactFile } from "./exact-file.js";

/** A longer verdict is cut nowhere: the owner reads it at the terminal instead, and the card stays inside the action record's cap. */
const MAX_VERDICT_CHARS = 20_000;
/** Each file costs two reads and a phone screen; past this the owner reads the diff at the terminal. */
const MAX_EVIDENCE_FILES = 10;

export type ReadVerdictText = (locator: SourceTextLocator) => Promise<string | null>;

type CiPolicyFact = Extract<OwnerAtHeadRow, "ci-policy-weakened" | "ci-policy-malformed">;
const CI_POLICY_FACT: Readonly<Record<CiPolicy["kind"], CiPolicyFact | undefined>> = { weakened: "ci-policy-weakened", malformed: "ci-policy-malformed", unchanged: undefined };
const isCiPolicyFact = (fact: OwnerAtHeadRow): fact is CiPolicyFact => fact === "ci-policy-weakened" || fact === "ci-policy-malformed";

/** The evidence's own reading as the headline, the verdict text it came from, and every labelled line that reading folds. */
interface CiPolicySection {
  fact: CiPolicyFact;
  ciPolicy: CiPolicy;
  verdictText: string;
  labelledLines: CiPolicyLabelledLine[];
}

/** A CI-policy section beside its changed `.github/` files, or a skill change's files. */
type EvidenceSection = (CiPolicySection & { files: ExactFile[] }) | { fact: "skill-path"; files: ExactFile[] };

export type OwnerEvidence =
  | { status: "none"; gateId: string }
  | { status: "ready"; gateId: string; head: string; mergeBase: string; facts: OwnerAtHeadRow[]; sections: EvidenceSection[] }
  | { status: "missing"; gateId: string; facts: string[]; reason: string; command: string };

/** The stored evidence a gate was opened on and the facts land would write from it, equal to the gate's marker. */
interface GateEvidence {
  land: LandGate;
  evidence: MergeEvidence;
  facts: OwnerAtHeadRow[];
}

interface EvidenceDeps {
  host: Pick<FactoryHost, "runs">;
  port: GitHubPort;
  readText?: ReadVerdictText;
}

const defaultReadText: ReadVerdictText = async (locator) => (await readClaudeText(locator)) ?? (await readCodexText(locator));

const short = (sha: string): string => sha.slice(0, 8);
const named = (facts: readonly string[]): string => (facts.length > 0 ? facts.join(", ") : "none");

/** The command the owner runs at the terminal when the card cannot carry the evidence. */
function terminalCommand(gateId: string, head: string): string {
  const slash = gateId.indexOf("/");
  return `titan-factory gate resolve ${gateId.slice(0, slash)} ${gateId.slice(slash + 1)} --json '${JSON.stringify({ decision: "merge", headSha: head })}'`;
}

/** `none` for a gate that names no owner-at-head fact; otherwise every section, or why the card cannot show one. */
export async function ownerEvidence(gate: GateRecord, { host, port, readText = defaultReadText }: EvidenceDeps): Promise<OwnerEvidence> {
  const land = landGate(gate);
  const row = ownerAtHeadRow(gate);
  if (land === undefined || row === undefined) return { status: "none", gateId: gate.id };
  const missing = (reason: string): OwnerEvidence => ({ status: "missing", gateId: gate.id, facts: markedFacts(gate, row), reason, command: terminalCommand(gate.id, land.head) });
  try {
    const read = gateEvidence(gate, host);
    if (typeof read === "string") return missing(read);
    const sections = await readSections(read, port, readText);
    if (typeof sections === "string") return missing(sections);
    return { status: "ready", gateId: gate.id, head: land.head, facts: read.facts, ...sections };
  } catch (error) {
    return missing(`the evidence could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The names the gate's marker carries, unknown ones included; a gate with no marker carries its one owner-at-head row. */
const markedFacts = (gate: GateRecord, row: string): string[] => ownerAtHeadNamesIn(gate.prompt) ?? [row];

/** Locates the evidence the gate was opened on, recomputes land's facts from it, and requires them to equal the marker. */
function gateEvidence(gate: GateRecord, host: Pick<FactoryHost, "runs">): GateEvidence | string {
  const land = landGate(gate);
  const row = ownerAtHeadRow(gate);
  if (land === undefined || row === undefined) return "the gate is not an owner-at-head land gate";
  const evidence = evidenceAt(gate, land, host);
  if (evidence === undefined) return `the run recorded no well-formed merge evidence at ${short(land.head)} before the gate opened`;
  const facts = factsFrom(land, evidence);
  const marked = markedFacts(gate, row);
  if (!isDeepStrictEqual(facts, marked)) return `the gate names ${named(marked)}, but its evidence holds ${named(facts)}`;
  return { land, evidence, facts };
}

/**
 * The last evidence step at the gate's head that completed by the time the gate opened. A re-read after that is not what
 * the gate was decided on; the fact equality check catches an earlier read the gate did not use either.
 */
function evidenceAt(gate: GateRecord, land: LandGate, host: Pick<FactoryHost, "runs">): MergeEvidence | undefined {
  const step = `${MERGE_EVIDENCE_STEP}:${land.head}`;
  const opened = Date.parse(gate.createdAt);
  const results = Object.values(host.runs.get(gate.id.slice(0, gate.id.indexOf("/")))?.stepResults ?? {})
    .filter((result) => (result.stepId === step || result.stepId.startsWith(`${step}:`)) && Date.parse(result.completedAt) <= opened)
    .sort((a, b) => Date.parse(a.completedAt) - Date.parse(b.completedAt));
  const stored = MergeEvidenceSchema.safeParse(results.at(-1)?.data?.result);
  if (!stored.success || stored.data.head !== land.head) return undefined;
  return mergeEvidenceAt(land.head, verdictWith(land.head, stored.data));
}

const verdictWith =
  (head: string, evidence: unknown) =>
  (at: string): Verdict | undefined =>
    at === head ? { kind: "MERGE", headSha: head, evidence } : undefined;

/** The facts land writes into the marker, read by land's own functions from this evidence alone. */
function factsFrom(land: LandGate, evidence: MergeEvidence): OwnerAtHeadRow[] {
  const verdictFor = verdictWith(land.head, evidence);
  const slash = land.rule.indexOf("/");
  const rule = { table: land.rule.slice(0, slash), rowId: land.rule.slice(slash + 1) };
  return ownerAtHeadRows(rule, { ownerAtHeadAt: (head) => ownerAtHeadAt(head, verdictFor) }, land.head, skillPathsAt(land.head, verdictFor));
}

/** Pins every file read: both sides by sha, the head to the evidence's own blob where it stored one, and a shared row budget. */
interface FileRead {
  port: GitHubPort;
  repo: string;
  base: string;
  head: string;
  pins: Record<string, string | null> | undefined;
  rowsLeft: number;
}

/**
 * A `files-unread` gate opened because its evidence holds no file list it can trust, and showing a live one would bring
 * back the card's own reader, so it reads missing (TP-4404 R1).
 */
async function readSections({ land, evidence, facts }: GateEvidence, port: GitHubPort, readText: ReadVerdictText): Promise<{ mergeBase: string; sections: EvidenceSection[] } | string> {
  if (facts.includes("files-unread")) return "the merge evidence holds no changed-file list the card can show (files-unread)";
  const { mergeBaseSha } = await port.compareFiles(land.repo, evidence.record.baseRef, land.head);
  const read: FileRead = { port, repo: land.repo, base: mergeBaseSha, head: land.head, pins: evidence.record.headBlobs, rowsLeft: MAX_LINES_PER_CARD };
  const sections: EvidenceSection[] = [];
  for (const fact of facts) {
    const files = await fileSection(fact === "skill-path" ? skillPathsIn(evidence.merge.changedPaths) : evidence.merge.changedPaths.filter(isGithubPath), read);
    if (typeof files === "string") return files;
    const section = isCiPolicyFact(fact) ? ciPolicySection(fact, evidence, await readText(evidence.record.verdictLocator)) : { fact: "skill-path" as const };
    if (typeof section === "string") return section;
    sections.push({ ...section, files });
  }
  return { mergeBase: mergeBaseSha, sections };
}

async function fileSection(paths: readonly string[], read: FileRead): Promise<ExactFile[] | string> {
  if (paths.length > MAX_EVIDENCE_FILES) return `${paths.length} files changed, more than the ${MAX_EVIDENCE_FILES} the card shows`;
  const files: ExactFile[] = [];
  for (const path of paths) {
    const [base, head] = await Promise.all([read.port.getFile(read.repo, path, read.base), read.port.getFile(read.repo, path, read.head)]);
    const pin = read.pins !== undefined && Object.hasOwn(read.pins, path) ? read.pins[path] : undefined;
    const file = exactFile(path, base, head, pin, Math.min(MAX_LINES_PER_FILE, read.rowsLeft));
    if (typeof file === "string") return file;
    read.rowsLeft -= file.rows.length;
    files.push(file);
  }
  return files;
}

/**
 * The headline is the evidence's own reading, verbatim. The verdict text is shown only when the shared reader still reads
 * that same reading from it, so the lines listed are the ones the gate's reading folded.
 */
function ciPolicySection(fact: CiPolicyFact, evidence: Pick<MergeEvidence, "ciPolicy">, text: string | null): CiPolicySection | string {
  const ciPolicy = evidence.ciPolicy;
  if (ciPolicy === undefined || CI_POLICY_FACT[ciPolicy.kind] !== fact) return `the evidence's CI-policy reading does not hold ${fact}`;
  if (text === null) return "the reviewer's verdict text could not be read from its session";
  if (text.length > MAX_VERDICT_CHARS) return `the reviewer's verdict runs past ${MAX_VERDICT_CHARS} characters`;
  const block = parseVerdictBlock(text);
  const read = "ciPolicy" in block ? block.ciPolicy : undefined;
  if (!isDeepStrictEqual(read, ciPolicy)) return "the reviewer's verdict text does not read as the evidence's CI-policy reading";
  return { fact, ciPolicy, verdictText: text, labelledLines: ciPolicyLabelledLines(text) };
}
