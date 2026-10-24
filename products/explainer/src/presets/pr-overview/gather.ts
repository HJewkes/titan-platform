import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { GatherDiagnostic } from "../repo-explainer/diagnostics.js";
import { codeGraphCallEdges, crossFileEdges, fileOf, type CallEdge, type CallEdgeReader } from "./call-edges.js";
import { prDiag } from "./diagnostics.js";
import { parseDiff, type DiffFile } from "./diff.js";
import { formatPrRef, parsePrRef, readPr, spawnGh, type GhRun, type PrNote, type PrRead, type PrView } from "./pr-read.js";
import { PR_FACT_KINDS, PR_FACT_SLOTS, PrFactSchema, type PrFact } from "./schemas.js";

/** The adapter name the pr-overview profile lists under `inputs.adapters`. */
export const PR_OVERVIEW_ADAPTER = "gatherPr";

export interface GatherPrOptions {
  /** `owner/repo#N`. */
  pr: string;
  /** A clone of the repo holding the PR's head commit; it need not be checked out. */
  clonePath: string;
  gh?: GhRun;
  callEdges?: CallEdgeReader;
}

export type GatherPrResult =
  | { ok: true; pr: string; head: string; facts: PrFact[]; diagnostics: GatherDiagnostic[] }
  | { ok: false; diagnostics: GatherDiagnostic[] };

const TASK_ID = /\b[A-Z]{2,5}-\d+\b/;
const VERDICT = /^Verdict:\s*(\S+)/m;
const MAX_FINDING_CHARS = 400;

/** The PR's linked task (the profile's `linked-task` precondition): the first task id in its title, body or branch. */
export function linkedTask(view: PrView): string | undefined {
  return [view.title, view.body, view.headRefName.toUpperCase()].map((text) => TASK_ID.exec(text)?.[0]).find((id) => id !== undefined);
}

const shortHash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 12);

function prFact(ref: string, view: PrView, task: string | undefined): PrFact {
  return { id: "pr", kind: "pr", slot: PR_FACT_SLOTS.pr, text: `${ref}: ${view.title}`, evidence: [], head: view.headRefOid, ...(task ? { task } : {}) };
}

function changeText(file: DiffFile): string {
  const name = file.status === "renamed" ? `${file.from} -> ${file.path}` : file.path;
  return `${file.status} ${name}: +${file.additions} -${file.deletions} in ${file.hunks.length} hunk${file.hunks.length === 1 ? "" : "s"}`;
}

function changeFact(file: DiffFile): PrFact {
  const evidence = file.status === "deleted" ? [] : file.hunks.filter((h) => h.headLines > 0).map((h) => ({ path: file.path, lineStart: h.headStart, lineEnd: h.headStart + h.headLines - 1 }));
  return {
    id: `change:${file.path}`, kind: "change", slot: PR_FACT_SLOTS.change, text: changeText(file), evidence,
    path: file.path, status: file.status, additions: file.additions, deletions: file.deletions,
  };
}

// The id hashes the note's origin and words, not its position, so a later comment never renumbers earlier findings.
function findingFact(origin: "review" | "comment", note: PrNote): PrFact | undefined {
  const body = note.body.trim();
  if (body === "") return undefined;
  const verdict = VERDICT.exec(body)?.[1] ?? note.state;
  const text = body.replace(/\s+/g, " ").slice(0, MAX_FINDING_CHARS);
  return { id: `finding:${shortHash(`${origin}\n${body}`)}`, kind: "finding", slot: PR_FACT_SLOTS.finding, text, evidence: [], ...(verdict ? { verdict } : {}) };
}

function callFact(edge: CallEdge): PrFact {
  const [from, to] = [fileOf(edge.from), fileOf(edge.to)];
  return {
    id: `call:${edge.from}->${edge.to}`, kind: "call", slot: PR_FACT_SLOTS.call, text: `${edge.from} calls ${edge.to}`,
    evidence: [{ path: from }, { path: to }], from: edge.from, to: edge.to, sites: edge.sites,
  };
}

const byKindThenId = (a: PrFact, b: PrFact): number => PR_FACT_KINDS.indexOf(a.kind) - PR_FACT_KINDS.indexOf(b.kind) || a.id.localeCompare(b.id);

function uniqueById(facts: PrFact[]): PrFact[] {
  return [...new Map(facts.map((fact) => [fact.id, fact])).values()];
}

function validFacts(facts: PrFact[], out: GatherDiagnostic[]): PrFact[] {
  return facts.filter((fact) => {
    const parsed = PrFactSchema.safeParse(fact);
    if (!parsed.success) out.push(prDiag("W-BAD-ROW", `fact ${fact.id} fails the schema: ${parsed.error.message}`, fact.id));
    return parsed.success;
  });
}

function noteFacts(view: PrView, out: GatherDiagnostic[]): PrFact[] {
  const notes = [...view.reviews.map((n) => findingFact("review", n)), ...view.comments.map((n) => findingFact("comment", n))];
  const facts = notes.filter((fact) => fact !== undefined);
  if (facts.length === 0) out.push(prDiag("W-NO-FINDINGS", "the PR has no review or comment with a body; the shortcomings block has nothing to say"));
  return facts;
}

async function edgeFacts(options: GatherPrOptions, head: string, files: DiffFile[], out: GatherDiagnostic[]): Promise<PrFact[]> {
  let edges: CallEdge[];
  try {
    edges = await (options.callEdges ?? codeGraphCallEdges)(options.clonePath, head);
  } catch (error) {
    out.push(prDiag("E-CALLGRAPH", `cannot index ${head} in the clone: ${error instanceof Error ? error.message : String(error)}`, options.clonePath));
    return [];
  }
  const across = crossFileEdges(edges, new Set(files.map((file) => file.path)));
  if (across.length === 0) out.push(prDiag("W-NO-EDGES", "no call crosses two changed files; the PR video has no sequence diagram"));
  return across.map(callFact);
}

async function readOrRefuse(options: GatherPrOptions, out: GatherDiagnostic[]): Promise<{ ref: string; read: PrRead } | undefined> {
  const parsed = parsePrRef(options.pr);
  if (!parsed) {
    out.push(prDiag("E-PR-REF", `"${options.pr}" is not owner/repo#N`));
    return undefined;
  }
  try {
    return { ref: formatPrRef(parsed), read: await readPr(parsed, options.gh ?? spawnGh) };
  } catch (error) {
    out.push(prDiag("E-PR-READ", `cannot read ${formatPrRef(parsed)} through gh: ${error instanceof Error ? error.message : String(error)}`));
    return undefined;
  }
}

/**
 * The pr-overview profile's gather stage body: one PR's facts from its diff, its reviews and comments, and the
 * calls across its changed files. Every check runs before deciding, so one refusal lists everything to fix.
 */
export async function gatherPr(options: GatherPrOptions): Promise<GatherPrResult> {
  const diagnostics: GatherDiagnostic[] = [];
  const got = await readOrRefuse(options, diagnostics);
  if (!got) return { ok: false, diagnostics };
  const { ref, read: { view, patch } } = got;
  const files = parseDiff(patch);
  if (files.length === 0) diagnostics.push(prDiag("E-EMPTY-DIFF", `${ref} changes no files`));
  const task = linkedTask(view);
  if (!task) diagnostics.push(prDiag("E-LINKED-TASK", `${ref} names no task id (like TP-123) in its title, body or branch`));
  const calls = await edgeFacts(options, view.headRefOid, files, diagnostics);
  const facts = [prFact(ref, view, task), ...files.map(changeFact), ...noteFacts(view, diagnostics), ...calls];
  const valid = validFacts(uniqueById(facts), diagnostics).sort(byKindThenId);
  if (diagnostics.some((d) => d.severity === "error")) return { ok: false, diagnostics };
  return { ok: true, pr: ref, head: view.headRefOid, facts: valid, diagnostics };
}

export const factsJsonl = (facts: readonly PrFact[]): string => facts.map((fact) => `${JSON.stringify(fact)}\n`).join("");

/** Writes `facts.jsonl` on success, and `gather.json` (the outcome and its diagnostics) either way. */
export async function writeGather(outDir: string, result: GatherPrResult): Promise<void> {
  await mkdir(outDir, { recursive: true });
  if (result.ok) await writeFile(join(outDir, "facts.jsonl"), factsJsonl(result.facts));
  const summary = result.ok ? { ok: true, pr: result.pr, head: result.head, facts: result.facts.length } : { ok: false };
  await writeFile(join(outDir, "gather.json"), `${JSON.stringify({ ...summary, diagnostics: result.diagnostics }, null, 2)}\n`);
}
