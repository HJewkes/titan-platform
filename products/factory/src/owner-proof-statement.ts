import { isDeepStrictEqual } from "node:util";
import type { ReviewGate } from "./gate-review-read.js";
import { presenceReason } from "./gate-resolve.js";
import { ItemSchema, itemsDigest, StatementSchema, type ProofItem, type Statement } from "./presence-proof.js";

/** Under the server's 300 s cap; covers the helper's 120 s dialog timeout plus the POST. */
const WINDOW_S = 240;
const MAX_REASON = 256;
const DIGEST = /^[0-9a-f]{64}$/;
/** A GitHub owner/name; anything else could break a line, hide text or read as a path in the dialog. */
const REPO = /^[A-Za-z0-9-]{1,39}\/(?!\.+$)[A-Za-z0-9._-]{1,100}$/;

/** The PR and head the owner names for a gate that carries none of its own. */
interface GateRef {
  repo: string;
  pr: number;
  headSha: string;
}

interface GateStatementInput {
  items: readonly ProofItem[];
  aud: string;
  keyId: string;
  /** Unix seconds. */
  iat: number;
  /** 32 hex, from `randomBytes(16)` at the call site. */
  nonce: string;
}

interface BuiltStatement {
  statement: Statement;
  bytes: Buffer;
  statementB64: string;
  digest: string;
}

/**
 * Maps a pending gate as the remote reviews it to a proof item. A merge gate brings its own PR and head; a gate with
 * none needs the owner's `ref`. A ref that disagrees with the gate's own PR throws rather than being signed.
 */
export function gateItem(row: ReviewGate, payload: Record<string, unknown>, ref?: GateRef): ProofItem {
  if (ref && Object.keys(ref).some((key) => !REF_KEYS.has(key))) throw new Error(`a ref for ${row.gateId} carries only repo, pr and headSha`);
  const own = refOf(row);
  if (own && ref && !sameRef(own, ref)) throw new Error(`${row.gateId} asks about ${own.repo}#${own.pr}@${own.headSha}, not the ref given`);
  const target = own ?? (ref && { repo: ref.repo, pr: ref.pr, headSha: ref.headSha });
  if (target === undefined) throw new Error(`${row.gateId} names no PR; pass --ref owner/repo#N --head <sha>`);
  const parsed = ItemSchema.safeParse({ gate: row.gateId, runId: row.runId, stepId: row.stepId, ...target, payload });
  if (!parsed.success) throw new Error(`${row.gateId} does not make a valid proof item: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

const REF_KEYS: ReadonlySet<string> = new Set(["repo", "pr", "headSha"]);

function refOf({ repo, pr, headSha }: ReviewGate): GateRef | undefined {
  return repo !== null && pr !== null && headSha !== null ? { repo, pr, headSha } : undefined;
}

function sameRef(a: GateRef, b: GateRef): boolean {
  return a.repo.toLowerCase() === b.repo.toLowerCase() && a.pr === b.pr && a.headSha === b.headSha;
}

/** The v1 gate-resolve statement and the exact bytes to sign; throws when the result would not parse on the server. */
export function buildGateStatement({ items, aud, keyId, iat, nonce }: GateStatementInput): BuiltStatement {
  const digest = itemsDigest(items);
  const draft = { v: 1, type: "titan-factory.gate-resolve", aud, keyId, nonce, iat, exp: iat + WINDOW_S, digest, items };
  const parsed = StatementSchema.safeParse(draft);
  if (!parsed.success) throw new Error(`statement is invalid: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  const bytes = Buffer.from(JSON.stringify(parsed.data), "utf8");
  return { statement: parsed.data, bytes, statementB64: bytes.toString("base64url"), digest };
}

/**
 * The Touch ID dialog text, at most 256 characters, for exactly the items `digest` covers. A single item always reads as
 * the local resolve dialog does, naming its gate, since the server never checks an owner-given ref on a single item. Two
 * or more read as a batch (the count, the digest prefix and as many PRs as fit) only when every item is a plain merge at
 * its own head; any other batch throws, as does any field that is unsafe to show.
 */
export function signReason(items: readonly ProofItem[], digest: string): string {
  if (!DIGEST.test(digest)) throw new Error("digest is not 64 hex");
  const checked = items.map(checkedItem);
  if (checked.length === 0) throw new Error("no items to sign");
  if (itemsDigest(checked) !== digest) throw new Error("digest does not match the items");
  const [only] = checked;
  if (checked.length === 1 && only !== undefined) return singleReason(only);
  if (!checked.every(isHeadMerge)) throw new Error("a batch only merges each gate at its own head");
  return batchReason(checked, digest);
}

function checkedItem(item: ProofItem): ProofItem {
  const parsed = ItemSchema.safeParse(item);
  if (!parsed.success) throw new Error("item does not make a valid proof item");
  return parsed.data;
}

/** The one answer a batch carries (gate-batch-plan.ts `itemRefusal`), so the dialog's PR and head are what it fires at. */
const isHeadMerge = ({ payload, headSha }: ProofItem): boolean => isDeepStrictEqual(payload, { decision: "merge", headSha });

function singleReason(item: ProofItem): string {
  const reason = presenceReason(item.gate, item.payload);
  if (reason === undefined) throw new Error(`${JSON.stringify(item.gate)} or its answer cannot be shown safely`);
  return reason;
}

function batchReason(items: readonly ProofItem[], digest: string): string {
  const parts = labelsOnce(items.map(prLabel));
  let reason = `Approve ${items.length} gates, batch ${digest.slice(0, 16)}:`;
  for (const [index, part] of parts.entries()) {
    const left = parts.length - index - 1;
    const candidate = `${reason} ${part}`;
    if (`${candidate}${moreSuffix(left)}`.length > MAX_REASON) return `${reason}${moreSuffix(left + 1)}`;
    reason = candidate;
  }
  return reason;
}

/** Two gates on one PR at one head name it once, with their count, so the dialog never repeats a label. */
function labelsOnce(labels: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return [...counts].map(([label, count]) => (count === 1 ? label : `${label} (${count} gates)`));
}

const moreSuffix = (left: number): string => (left > 0 ? ` +${left} more` : "");

function prLabel({ repo, pr, headSha }: ProofItem): string {
  if (!REPO.test(repo)) throw new Error(`repo ${JSON.stringify(repo)} cannot be shown safely`);
  return `${repo}#${pr}@${headSha.slice(0, 7)}`;
}
