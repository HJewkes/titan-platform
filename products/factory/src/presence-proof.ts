import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

const HEX = (length: number) => new RegExp(`^[0-9a-f]{${length}}$`);
const GATE_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Enough for every Shepherd run waiting at once. */
const MAX_ITEMS = 200;
const MAX_STATEMENT_BYTES = 256 * 1024;
const MAX_WINDOW_S = 300;
const EXPIRY_SKEW_S = 30;
const ISSUE_SKEW_S = 60;

/** After-stage gates follow a merge into deploy, release or activation; they stay one per proof. */
const RELEASE_STEPS: ReadonlySet<string> = new Set(["after-stages"]);
const HARDWARE_STEP = /device|hardware/;

const ItemSchema = z.strictObject({
  gate: z.string().regex(GATE_ID),
  runId: z.string().min(1),
  stepId: z.string().min(1),
  repo: z.string().min(1),
  pr: z.number().int().positive(),
  headSha: z.string().regex(HEX(40)),
  payload: z.record(z.string(), z.json()),
});

/** The v1 statement the owner's Mac signs; the server verifies the signature over its exact bytes before parsing it. */
export const StatementSchema = z.strictObject({
  v: z.literal(1),
  type: z.literal("titan-factory.gate-resolve"),
  aud: z.string().min(1),
  keyId: z.string().regex(HEX(16)),
  nonce: z.string().regex(HEX(32)),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative(),
  digest: z.string().regex(HEX(64)),
  items: z.array(ItemSchema).min(1).max(MAX_ITEMS),
});

export type Statement = z.infer<typeof StatementSchema>;
export type ProofItem = z.infer<typeof ItemSchema>;

export type Refusal =
  | "bad-signature"
  | "unknown-key"
  | "expired"
  | "not-yet-valid"
  | "window-too-long"
  | "wrong-aud"
  | "digest-mismatch"
  | "malformed"
  | "mixed-release-batch";

export type ProofResult = { ok: true; statement: Statement; keyId: string } | { ok: false; refusal: Refusal };

export interface ProofInput {
  statementB64: string;
  signatureB64: string;
}

/** Installed owner public keys by key id. */
export type KeyRing = ReadonlyMap<string, KeyObject>;

/** Sorted-key JSON, so the digest does not depend on the order a payload's keys were written in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** What the owner approves: every item in order, covering the run, step and answer as well as the PR and head. */
export function itemsDigest(items: readonly ProofItem[]): string {
  const rows = items.map(({ gate, runId, stepId, repo, pr, headSha, payload }) => [gate, runId, stepId, repo, pr, headSha, payload]);
  return createHash("sha256").update(canonical(rows)).digest("hex");
}

/** The first 16 hex characters of sha256 over the key's SPKI DER. */
export function keyIdOf(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

/** Builds the key ring from public keys; a key that is not ECDSA P-256 is an error, never skipped silently. */
export function keyRing(keys: readonly (KeyObject | string)[]): KeyRing {
  const ring = new Map<string, KeyObject>();
  for (const key of keys) {
    const publicKey = typeof key === "string" ? createPublicKey(key) : key;
    if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      throw new Error("owner key is not ECDSA P-256");
    }
    ring.set(keyIdOf(publicKey), publicKey);
  }
  return ring;
}

function decodeBase64url(text: string): Buffer | undefined {
  if (!BASE64URL.test(text)) return undefined;
  const bytes = Buffer.from(text, "base64url");
  return bytes.toString("base64url") === text ? bytes : undefined;
}

/** Ids of the keys that verify the DER signature over exactly these bytes. */
function signingKeys(ring: KeyRing, bytes: Buffer, signature: Buffer): string[] {
  const matches: string[] = [];
  for (const [id, key] of ring) {
    try {
      if (verify("sha256", bytes, { key, dsaEncoding: "der" }, signature)) matches.push(id);
    } catch {
      // A signature that is not valid DER fails this key like any other bad signature.
    }
  }
  return matches;
}

function parseStatement(bytes: Buffer): Statement | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = StatementSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function isSingleOnly({ stepId }: ProofItem): boolean {
  return RELEASE_STEPS.has(stepId) || HARDWARE_STEP.test(stepId);
}

/** Checks that need the statement's content, in the order a reader would ask them; undefined means all pass. */
function contentRefusal(statement: Statement, signer: string, now: number, aud: string): Refusal | undefined {
  if (statement.keyId !== signer) return "unknown-key";
  if (statement.exp <= statement.iat) return "malformed";
  if (statement.exp - statement.iat > MAX_WINDOW_S) return "window-too-long";
  if (now > statement.exp + EXPIRY_SKEW_S) return "expired";
  if (statement.iat > now + ISSUE_SKEW_S) return "not-yet-valid";
  if (statement.aud !== aud) return "wrong-aud";
  if (statement.digest !== itemsDigest(statement.items)) return "digest-mismatch";
  if (statement.items.length > 1 && statement.items.some(isSingleOnly)) return "mixed-release-batch";
  return undefined;
}

/**
 * Verifies an owner presence proof: ECDSA P-256 SHA-256 DER over the received statement bytes first, then the parse,
 * then the window, audience, digest and batch rules. `now` is unix seconds. It never throws; every doubt is a refusal.
 * Nonce replay needs stored state, so it is the caller's check: record `statement.nonce` and refuse a repeat.
 */
export function verifyProof(input: ProofInput, keys: KeyRing, now: number, aud: string): ProofResult {
  const bytes = decodeBase64url(input.statementB64);
  const signature = decodeBase64url(input.signatureB64);
  if (bytes === undefined || signature === undefined || bytes.length > MAX_STATEMENT_BYTES) return { ok: false, refusal: "malformed" };
  if (keys.size === 0) return { ok: false, refusal: "unknown-key" };
  const [signer] = signingKeys(keys, bytes, signature);
  if (signer === undefined) return { ok: false, refusal: "bad-signature" };
  const statement = parseStatement(bytes);
  if (statement === undefined) return { ok: false, refusal: "malformed" };
  const refusal = contentRefusal(statement, signer, now, aud);
  return refusal === undefined ? { ok: true, statement, keyId: signer } : { ok: false, refusal };
}
