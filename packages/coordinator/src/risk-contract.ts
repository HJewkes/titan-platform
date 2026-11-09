import { createHash } from "node:crypto";
import { z } from "zod";

const contractId = z.string().regex(/^RC-[A-Z0-9]+(?:-[A-Z0-9]+)*$/, "id must look like RC-GUARD-1");

export const ownerApprovalSchema = z.strictObject({
  decision: z.string().min(1),
  ruleSha256: z.string().regex(/^[0-9a-f]{64}$/, "ruleSha256 must be 64 lowercase hex chars"),
});

export const riskContractSchema = z.strictObject({
  id: contractId,
  programme: z.string().min(1).optional(),
  kind: z.enum(["security", "authority", "policy", "migration"]),
  rule: z.string().trim().min(1),
  delta: z.enum(["strictly-stricter", "narrower", "wider", "mixed"]),
  paths: z.array(z.string().min(1)).min(1),
  requires: z.array(z.enum(["parse-budget", "guard-fuzz", "allowed-rows-pinned", "fix-proof"])),
  release: z.enum(["shepherd", "seat", "owner-live", "seat-adversary"]),
  ownerApproval: ownerApprovalSchema.optional(),
});

/** A plan that cites a programme contract instead of restating it. */
export const riskContractRefSchema = z.strictObject({ id: contractId, programme: z.string().min(1) });

export type OwnerApproval = z.infer<typeof ownerApprovalSchema>;
export type RiskContract = z.infer<typeof riskContractSchema>;
export type RiskContractRef = z.infer<typeof riskContractRefSchema>;
export type RiskContractRead =
  | { contract: RiskContract | RiskContractRef; problems?: undefined }
  | { contract?: undefined; problems: string[] };
export type ResolvedRiskContract =
  | { contract: RiskContract; problems?: undefined }
  | { contract?: undefined; problems: string[] };
export type ApprovalState = "approved" | `unmet:${string}`;

const CONTRACT_BLOCK = /^```risk-contract[ \t]*\n([\s\S]*?)^```[ \t]*$/gm;

/** The plan's `risk-contract` block, or why it is missing, duplicated, unreadable or the wrong shape. */
export function readRiskContract(planText: string): RiskContractRead {
  const bodies = [...planText.matchAll(CONTRACT_BLOCK)].map((match) => match[1] ?? "");
  if (bodies.length === 0) return { problems: ["plan has no risk-contract block"] };
  if (bodies.length > 1) return { problems: [`plan has ${bodies.length} risk-contract blocks; one is allowed`] };
  let json: unknown;
  try {
    json = JSON.parse(bodies[0] ?? "");
  } catch (err) {
    return { problems: [`risk-contract block is not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const full = riskContractSchema.safeParse(json);
  if (full.success) return { contract: full.data };
  const ref = riskContractRefSchema.safeParse(json);
  if (ref.success) return { contract: ref.data };
  return { problems: full.error.issues.map(shapeProblem) };
}

const shapeProblem = (issue: z.core.$ZodIssue): string =>
  issue.path.length === 0 ? `risk-contract block: ${issue.message}` : `risk-contract block at ${issue.path.join(".")}: ${issue.message}`;

/** sha256 of the rule after NFC normalisation and whitespace collapsing, so reflowing the sentence keeps its approval. */
export function ruleDigest(rule: string): string {
  const canonical = rule.normalize("NFC").replace(/\s+/g, " ").trim();
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** `approved` only when the owner's decision is recorded and the rule is the sentence the owner approved. */
export function approvalState(contract: RiskContract, decisionsText: string): ApprovalState {
  const approval = contract.ownerApproval;
  if (approval === undefined) return "unmet:no owner approval";
  if (approval.ruleSha256 !== ruleDigest(contract.rule)) return "unmet:rule changed since approval";
  if (!decisionRecorded(approval.decision, decisionsText)) return `unmet:decision ${approval.decision} not recorded`;
  return "approved";
}

type Entry = { kind: "heading"; level: number; label: string } | { kind: "item"; label: string; text: string };

const HEADING = /^(#{1,6})[ \t]+(\S+)/;
const ITEM = /^[ \t]*(\d+)[.)][ \t]+(.*)$/;

function entriesOf(decisionsText: string): Entry[] {
  return decisionsText.split(/\r?\n/).flatMap((line): Entry[] => {
    const heading = HEADING.exec(line);
    if (heading) return [{ kind: "heading", level: heading[1]?.length ?? 1, label: bareLabel(heading[2] ?? "") }];
    const item = ITEM.exec(line);
    return item ? [{ kind: "item", label: item[1] ?? "", text: item[2] ?? "" }] : [];
  });
}

const bareLabel = (token: string): string => token.replace(/[.:,;]+$/, "");
const firstToken = (text: string): string => bareLabel(text.split(/\s/, 1)[0] ?? "");

// A decision id is a heading or numbered item label ("## 341", "241."), or a part of one: "341(2)" is item 2 under
// heading 341, or a "(2)" inside numbered item 341.
function decisionRecorded(decision: string, decisionsText: string): boolean {
  const entries = entriesOf(decisionsText);
  if (entries.some((entry) => entry.label === decision || (entry.kind === "item" && firstToken(entry.text) === decision))) {
    return true;
  }
  const part = /^(.+)\((\d+)\)$/.exec(decision);
  if (!part) return false;
  const [, parent = "", index = ""] = part;
  return entries.some(
    (entry, at) =>
      (entry.kind === "item" && entry.label === parent && entry.text.includes(`(${index})`)) ||
      (entry.kind === "heading" && entry.label === parent && sectionHasItem(entries, at, index)),
  );
}

function sectionHasItem(entries: Entry[], headingAt: number, index: string): boolean {
  const heading = entries[headingAt];
  if (heading?.kind !== "heading") return false;
  for (const entry of entries.slice(headingAt + 1)) {
    if (entry.kind === "heading" && entry.level <= heading.level) return false;
    if (entry.kind === "item" && entry.label === index) return true;
  }
  return false;
}

/**
 * The full contract a plan's block stands for. A block with no `programme` is its own contract; otherwise the
 * programme file (read through the host's `read`) holds it, and a restated field that differs from it is a problem.
 */
export function resolveProgramme(
  contract: RiskContract | RiskContractRef,
  read: (path: string) => string | undefined,
): ResolvedRiskContract {
  if (contract.programme === undefined) return isFull(contract) ? { contract } : { problems: ["contract has no programme"] };
  const text = read(contract.programme);
  if (text === undefined) return { problems: [`programme ${contract.programme} not found`] };
  const programme = readRiskContract(text);
  if (programme.contract === undefined) return { problems: programme.problems.map((p) => `programme ${contract.programme}: ${p}`) };
  if (!isFull(programme.contract)) return { problems: [`programme ${contract.programme} cites another programme`] };
  const mismatched = restatedMismatches(contract, programme.contract);
  if (mismatched.length > 0) return { problems: [`plan block differs from programme ${contract.programme} at ${mismatched.join(", ")}`] };
  return { contract: programme.contract };
}

const isFull = (contract: RiskContract | RiskContractRef): contract is RiskContract => "rule" in contract;

function restatedMismatches(block: RiskContract | RiskContractRef, programme: RiskContract): string[] {
  const restated = Object.entries(block).filter(([key]) => key !== "programme");
  const target = Object.fromEntries(Object.entries(programme).filter(([key]) => key !== "programme"));
  return restated.filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(target[key])).map(([key]) => key);
}
