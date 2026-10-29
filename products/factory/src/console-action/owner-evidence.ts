/**
 * TP-4404: the console card for an owner-at-head merge gate (D21, TP-4141) is a projection of the merge evidence the gate was
 * opened on, never a read of its own. Its facts are recomputed from that evidence with land's own functions and must equal
 * the gate's marker; a CI-policy section is the evidence's own reading beside the verdict text it was read from. Anything the
 * card cannot show from that object reads as missing, and the gate stays on the terminal.
 */
import { isDeepStrictEqual } from "node:util";
import type { GateRecord } from "@titan-design/hitl";
import { ciPolicyLabelledLines, parseVerdictBlock, readClaudeText, readCodexText, type CiPolicy, type CiPolicyLabelledLine, type SourceTextLocator } from "@titan-design/session-read";
import { landGate, ownerAtHeadRow, type LandGate } from "../coordinator-evidence.js";
import type { FactoryHost } from "../host.js";
import { ownerAtHeadNamesIn, type OwnerAtHeadRow } from "../owner-at-head.js";
import { MERGE_EVIDENCE_STEP, type MergeEvidence } from "../shepherd/merge-facts.js";
import type { Verdict } from "../shepherd/phases.js";
import { mergeEvidenceAt, ownerAtHeadAt, skillPathsAt } from "../shepherd/policy.js";
import { MergeEvidenceSchema } from "../shepherd/review-schemas.js";
import { ownerAtHeadRows } from "../workflows/land-approval.js";

/** A longer verdict is cut nowhere: the owner reads it at the terminal instead, and the card stays inside the action record's cap. */
const MAX_VERDICT_CHARS = 20_000;

export type ReadVerdictText = (locator: SourceTextLocator) => Promise<string | null>;

type CiPolicyFact = Extract<OwnerAtHeadRow, "ci-policy-weakened" | "ci-policy-malformed">;
const CI_POLICY_FACT: Readonly<Record<CiPolicy["kind"], CiPolicyFact | undefined>> = { weakened: "ci-policy-weakened", malformed: "ci-policy-malformed", unchanged: undefined };
const isCiPolicyFact = (fact: OwnerAtHeadRow): fact is CiPolicyFact => fact === "ci-policy-weakened" || fact === "ci-policy-malformed";

/** The evidence's own reading as the headline, the verdict text it came from, and every labelled line that reading folds. */
export interface CiPolicySection {
  fact: CiPolicyFact;
  ciPolicy: CiPolicy;
  verdictText: string;
  labelledLines: CiPolicyLabelledLine[];
}

export type OwnerEvidence =
  | { status: "none"; gateId: string }
  | { status: "ready"; gateId: string; head: string; facts: OwnerAtHeadRow[]; sections: CiPolicySection[] }
  | { status: "missing"; gateId: string; facts: string[]; reason: string; command: string };

/** The stored evidence a gate was opened on and the facts land would write from it, equal to the gate's marker. */
export interface GateEvidence {
  land: LandGate;
  evidence: MergeEvidence;
  facts: OwnerAtHeadRow[];
}

interface EvidenceDeps {
  host: Pick<FactoryHost, "runs">;
  readText?: ReadVerdictText;
}

const defaultReadText: ReadVerdictText = async (locator) => (await readClaudeText(locator)) ?? (await readCodexText(locator));

const short = (sha: string): string => sha.slice(0, 8);
const named = (facts: readonly string[]): string => (facts.length > 0 ? facts.join(", ") : "none");

/** The command the owner runs at the terminal when the card cannot carry the evidence. */
export function terminalCommand(gateId: string, head: string): string {
  const slash = gateId.indexOf("/");
  return `titan-factory gate resolve ${gateId.slice(0, slash)} ${gateId.slice(slash + 1)} --json '${JSON.stringify({ decision: "merge", headSha: head })}'`;
}

/** `none` for a gate that names no owner-at-head fact; otherwise every section, or why the card cannot show one. */
export async function ownerEvidence(gate: GateRecord, { host, readText = defaultReadText }: EvidenceDeps): Promise<OwnerEvidence> {
  const land = landGate(gate);
  const row = ownerAtHeadRow(gate);
  if (land === undefined || row === undefined) return { status: "none", gateId: gate.id };
  const missing = (reason: string): OwnerEvidence => ({ status: "missing", gateId: gate.id, facts: markedFacts(gate, row), reason, command: terminalCommand(gate.id, land.head) });
  try {
    const read = gateEvidence(gate, host);
    if (typeof read === "string") return missing(read);
    const sections = await readSections(read, readText);
    if (typeof sections === "string") return missing(sections);
    return { status: "ready", gateId: gate.id, head: land.head, facts: read.facts, sections };
  } catch (error) {
    return missing(`the evidence could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** The names the gate's marker carries, unknown ones included; a gate with no marker carries its one owner-at-head row. */
const markedFacts = (gate: GateRecord, row: string): string[] => ownerAtHeadNamesIn(gate.prompt) ?? [row];

/** Locates the evidence the gate was opened on, recomputes land's facts from it, and requires them to equal the marker. */
export function gateEvidence(gate: GateRecord, host: Pick<FactoryHost, "runs">): GateEvidence | string {
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

async function readSections({ evidence, facts }: GateEvidence, readText: ReadVerdictText): Promise<CiPolicySection[] | string> {
  const fileFacts = facts.filter((fact) => !isCiPolicyFact(fact));
  if (fileFacts.length > 0) return `file sections are not yet shown on the console (${named(fileFacts)})`;
  const sections: CiPolicySection[] = [];
  for (const fact of facts.filter(isCiPolicyFact)) {
    const section = ciPolicySection(fact, evidence, await readText(evidence.record.verdictLocator));
    if (typeof section === "string") return section;
    sections.push(section);
  }
  return sections;
}

/**
 * The headline is the evidence's own reading, verbatim. The verdict text is shown only when the shared reader still reads
 * that same reading from it, so the lines listed are the ones the gate's reading folded.
 */
export function ciPolicySection(fact: CiPolicyFact, evidence: Pick<MergeEvidence, "ciPolicy">, text: string | null): CiPolicySection | string {
  const ciPolicy = evidence.ciPolicy;
  if (ciPolicy === undefined || CI_POLICY_FACT[ciPolicy.kind] !== fact) return `the evidence's CI-policy reading does not hold ${fact}`;
  if (text === null) return "the reviewer's verdict text could not be read from its session";
  if (text.length > MAX_VERDICT_CHARS) return `the reviewer's verdict runs past ${MAX_VERDICT_CHARS} characters`;
  const block = parseVerdictBlock(text);
  const read = "ciPolicy" in block ? block.ciPolicy : undefined;
  if (!isDeepStrictEqual(read, ciPolicy)) return "the reviewer's verdict text does not read as the evidence's CI-policy reading";
  return { fact, ciPolicy, verdictText: text, labelledLines: ciPolicyLabelledLines(text) };
}
