/**
 * TP-4404: the evidence an owner-at-head merge gate (D21, TP-4141) needs before the console may answer it, read live at the
 * gate's pinned head. Each fact the gate names gets a section: a weakened or malformed CI policy shows the changed `.github/`
 * files against the merge base beside the reviewer's own verdict text (its `CI-policy:` line and rationale); a skill change
 * shows the repo skill files; unread files show every changed file. A rename counts both its paths, so the old one shows as
 * deleted. The console shows the sections and posts their digest; the factory reads them again at the tap and resolves only
 * on the same digest. Anything the card could not show in full (a moved head, a capped diff, a line the card cut or
 * stripped, an unreadable verdict) reads as missing, and the gate stays on the terminal.
 */
import { createHash } from "node:crypto";
import type { GitHubPort } from "@titan-design/github";
import type { GateRecord } from "@titan-design/hitl";
import { readClaudeText, readCodexText, type SourceTextLocator } from "@titan-design/session-read";
import { z } from "zod";
import { landGate, ownerAtHeadRow, type LandGate } from "../coordinator-evidence.js";
import type { FactoryHost } from "../host.js";
import { isOwnerAtHeadRow, ownerAtHeadRowsIn, type OwnerAtHeadRow } from "../owner-at-head.js";
import { ciPolicyChanges, linesOf, type CiPolicyFile, type CiPolicyFileChange } from "../shepherd/ci-policy-changes.js";
import { isGithubPath } from "../shepherd/ci-policy-read.js";
import { LocatorSchema } from "../shepherd/review-schemas.js";
import { skillPathsIn } from "../shepherd/skill-paths.js";

/** Each file costs two reads and a phone screen; past this the owner reads the diff at the terminal. */
const MAX_EVIDENCE_FILES = 10;
/** A longer verdict is cut nowhere: the owner reads it at the terminal instead. */
const MAX_REVIEW_CHARS = 20_000;

export type ReadReviewerText = (locator: SourceTextLocator) => Promise<string | null>;

interface EvidenceDeps {
  host: Pick<FactoryHost, "runs">;
  port: GitHubPort;
  readText?: ReadReviewerText;
}

/** The reviewer's `CI-policy:` line as written, and the whole verdict message it ends, which holds the rationale. */
interface ReviewerText {
  line: string;
  text: string;
}

interface EvidenceSection {
  fact: OwnerAtHeadRow;
  files: CiPolicyFileChange[];
  reviewer?: ReviewerText;
}

export type OwnerEvidence =
  | { status: "none"; gateId: string }
  | { status: "ready"; gateId: string; head: string; mergeBase: string; facts: OwnerAtHeadRow[]; sections: EvidenceSection[]; digest: string }
  | { status: "missing"; gateId: string; facts: string[]; reason: string; command: string };

const CI_POLICY_FACTS: ReadonlySet<OwnerAtHeadRow> = new Set(["ci-policy-weakened", "ci-policy-malformed"]);
const CI_POLICY_LINE = /^\s*ci-?policy\s*:/i;

const defaultReadText: ReadReviewerText = async (locator) => (await readClaudeText(locator)) ?? (await readCodexText(locator));

const short = (sha: string): string => sha.slice(0, 8);

/** The command the owner runs at the terminal when the card cannot carry the evidence. */
export function terminalCommand(gateId: string, head: string): string {
  const slash = gateId.indexOf("/");
  return `titan-factory gate resolve ${gateId.slice(0, slash)} ${gateId.slice(slash + 1)} --json '${JSON.stringify({ decision: "merge", headSha: head })}'`;
}

/** `none` for a gate that names no owner-at-head fact; otherwise every section, or why the card cannot show one. */
export async function ownerEvidence(gate: GateRecord, deps: EvidenceDeps): Promise<OwnerEvidence> {
  const land = landGate(gate);
  const row = ownerAtHeadRow(gate);
  if (land === undefined || row === undefined) return { status: "none", gateId: gate.id };
  const facts = ownerAtHeadRowsIn(gate.prompt) ?? [row];
  const missing = (reason: string): OwnerEvidence => ({ status: "missing", gateId: gate.id, facts, reason, command: terminalCommand(gate.id, land.head) });
  const known = facts.filter(isOwnerAtHeadRow);
  if (known.length === 0 || known.length !== facts.length) return missing(`the gate names ${facts.join(", ")}, which the console cannot show`);
  try {
    const read = await readSections(gate.id, land, known, deps);
    if (typeof read === "string") return missing(read);
    const body = { gateId: gate.id, head: land.head, mergeBase: read.mergeBase, facts: known, sections: read.sections };
    return { status: "ready", ...body, digest: evidenceDigest(body) };
  } catch (error) {
    return missing(`the evidence could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Key order is fixed by construction, so the console's copy and the tap's re-read hash the same bytes. */
const evidenceDigest = (body: object): string => createHash("sha256").update(JSON.stringify(body)).digest("hex");

interface Sections {
  mergeBase: string;
  sections: EvidenceSection[];
}

interface Refs {
  repo: string;
  base: string;
  head: string;
}

async function readSections(gateId: string, land: LandGate, facts: readonly OwnerAtHeadRow[], deps: EvidenceDeps): Promise<Sections | string> {
  const pull = await deps.port.getPr(land.repo, land.pr);
  if (pull.state !== "open" || pull.headSha !== land.head) return headMoved(land, pull.headSha);
  const compare = await deps.port.compareFiles(land.repo, pull.baseRef, land.head);
  if (compare.truncated) return "GitHub cut the changed-file list short";
  const renamedFrom = (await deps.port.listPrFiles(land.repo, land.pr)).flatMap((file) => (file.previousPath === undefined ? [] : [file.previousPath]));
  const after = await deps.port.getPr(land.repo, land.pr);
  if (after.headSha !== land.head) return headMoved(land, after.headSha);
  const changed = [...new Set([...compare.files, ...renamedFrom])];
  const refs = { repo: land.repo, base: compare.mergeBaseSha, head: land.head };
  const read = { port: deps.port, refs, reviewer: () => reviewerTextAt(gateId, land.head, deps) };
  const sections: EvidenceSection[] = [];
  for (const fact of facts) {
    const section = await readSection(fact, changed, read);
    if (typeof section === "string") return section;
    sections.push(section);
  }
  return { mergeBase: compare.mergeBaseSha, sections };
}

const headMoved = (land: LandGate, current: string): string => `${land.repo}#${land.pr} is at ${short(current)}, not the gate's ${short(land.head)}`;

const NO_FILES: Record<OwnerAtHeadRow, string> = {
  "ci-policy-weakened": "no .github/ file changed, so the weakening is outside what the card shows",
  "ci-policy-malformed": "no .github/ file changed, so the card has no CI-policy diff to show",
  "skill-path": "no repo skill file changed at this head",
  "files-unread": "the PR changes no files GitHub lists",
};

function pathsFor(fact: OwnerAtHeadRow, files: readonly string[]): string[] {
  if (CI_POLICY_FACTS.has(fact)) return files.filter(isGithubPath);
  return fact === "skill-path" ? skillPathsIn(files) : [...files];
}

interface SectionRead {
  port: GitHubPort;
  refs: Refs;
  reviewer: () => Promise<ReviewerText | string>;
}

async function readSection(fact: OwnerAtHeadRow, changed: readonly string[], { port, refs, reviewer }: SectionRead): Promise<EvidenceSection | string> {
  const paths = pathsFor(fact, changed);
  if (paths.length === 0) return NO_FILES[fact];
  if (paths.length > MAX_EVIDENCE_FILES) return `${fact} covers ${paths.length} files, more than the ${MAX_EVIDENCE_FILES} the card shows`;
  const read = await readFiles(port, refs, paths);
  const files = ciPolicyChanges(read);
  const capped = files.find((file) => file.omitted > 0);
  if (capped !== undefined) return `${capped.path} changes more lines than the card shows`;
  const cut = files.find((file, index) => !shownWhole(file, read[index]!));
  if (cut !== undefined) return `${cut.path} has a changed line the card cuts or strips`;
  if (!CI_POLICY_FACTS.has(fact)) return { fact, files };
  const text = await reviewer();
  return typeof text === "string" ? text : { fact, files, reviewer: text };
}

/** Both sides of each path against the merge base; a file absent on one side was added or deleted, so that side is empty. */
async function readFiles(port: GitHubPort, { repo, base, head }: Refs, paths: readonly string[]): Promise<CiPolicyFile[]> {
  return Promise.all(
    paths.map(async (path) => {
      const [before, after] = await Promise.all([port.getFile(repo, path, base), port.getFile(repo, path, head)]);
      return { path, before: before?.content ?? "", after: after?.content ?? "" };
    }),
  );
}

/**
 * The shared diff cuts each line at 160 characters and strips control characters, which is fine for a notice but not for
 * a merge: the owner must see every character the gate covers, so any line or path shown other than as written fails closed.
 */
function shownWhole(change: CiPolicyFileChange, file: CiPolicyFile): boolean {
  const sides = { "-": linesOf(file.before), "+": linesOf(file.after) };
  return change.path === file.path && change.lines.every((line) => line.text === sides[line.side][line.n - 1]);
}

const MergeEvidenceStep = z.looseObject({ result: z.looseObject({ head: z.string(), record: z.looseObject({ verdictLocator: LocatorSchema }) }) });

/** The locator of the MERGE verdict the run's last merge-evidence step at this head recorded. */
function verdictLocatorAt(host: EvidenceDeps["host"], runId: string, head: string): SourceTextLocator | undefined {
  const step = `sh-merge-evidence:${head}`;
  const results = Object.values(host.runs.get(runId)?.stepResults ?? {}).filter((result) => result.stepId === step || result.stepId.startsWith(`${step}:`));
  const parsed = results.map((result) => MergeEvidenceStep.safeParse(result.data).data).filter((data) => data?.result.head === head);
  return parsed.at(-1)?.result.record.verdictLocator;
}

async function reviewerTextAt(gateId: string, head: string, { host, readText = defaultReadText }: EvidenceDeps): Promise<ReviewerText | string> {
  const locator = verdictLocatorAt(host, gateId.slice(0, gateId.indexOf("/")), head);
  if (locator === undefined) return `the run recorded no MERGE evidence at ${short(head)}`;
  const text = await readText(locator);
  if (text === null) return "the reviewer's verdict text could not be read from its session";
  if (text.length > MAX_REVIEW_CHARS) return `the reviewer's verdict runs past ${MAX_REVIEW_CHARS} characters`;
  const line = text.split("\n").filter((each) => CI_POLICY_LINE.test(each)).at(-1);
  return line === undefined ? "the reviewer's verdict has no CI-policy line" : { line: line.trim(), text };
}
