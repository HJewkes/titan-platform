import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import type { z } from "zod";

const BASE64URL = /^[A-Za-z0-9_-]+$/;

const MAX_STATEMENT_BYTES = 256 * 1024;
const MAX_WINDOW_S = 300;
const EXPIRY_SKEW_S = 30;
const ISSUE_SKEW_S = 60;
/** Real payloads are a few levels deep; the bound keeps a hostile one from overflowing the stack. */
const MAX_PAYLOAD_DEPTH = 32;

/** The refusals the core itself returns; a statement kind may add its own. */
export type Refusal = "bad-signature" | "unknown-key" | "expired" | "not-yet-valid" | "window-too-long" | "wrong-aud" | "malformed";

export type Verified<S, R extends string = never> = { ok: true; statement: S; keyId: string } | { ok: false; refusal: Refusal | R };

/** What every statement type shares. */
export interface Envelope {
  aud: string;
  keyId: string;
  iat: number;
  exp: number;
}

/** One statement type: its schema, which must pin a `type` literal, and the checks only that type knows. */
export interface StatementKind<S extends Envelope, R extends string = never> {
  schema: z.ZodType<S>;
  refusal: (statement: S) => Refusal | R | undefined;
}

export interface ProofInput {
  statementB64: string;
  signatureB64: string;
}

/** Installed owner public keys by key id. */
export type KeyRing = ReadonlyMap<string, KeyObject>;

/** Sorted-key JSON, so a digest does not depend on the order a payload's keys were written in. Throws past the depth bound. */
export function canonical(value: unknown, depth = 0): string {
  if (depth > MAX_PAYLOAD_DEPTH) throw new RangeError("payload nested too deeply");
  if (Array.isArray(value)) return `[${value.map((inner) => canonical(inner, depth + 1)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner, depth + 1)}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

function parseStatement<S>(bytes: Buffer, schema: z.ZodType<S>): S | undefined {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Checks that need the envelope, in the order a reader would ask them; undefined means all pass. */
function envelopeRefusal(statement: Envelope, signer: string, now: number, aud: string): Refusal | undefined {
  if (statement.keyId !== signer) return "unknown-key";
  if (statement.exp <= statement.iat) return "malformed";
  if (statement.exp - statement.iat > MAX_WINDOW_S) return "window-too-long";
  if (now > statement.exp + EXPIRY_SKEW_S) return "expired";
  if (statement.iat > now + ISSUE_SKEW_S) return "not-yet-valid";
  if (statement.aud !== aud) return "wrong-aud";
  return undefined;
}

/**
 * Verifies an owner-signed statement: ECDSA P-256 SHA-256 DER over the received statement bytes first, then the parse,
 * then the window (at most 300 s, 30 s expiry skew, 60 s issue skew), the audience and the kind's own checks. `now` is
 * unix seconds. It never throws; every doubt is a refusal.
 *
 * Nonce replay needs stored state, so the caller records `statement.nonce` and refuses a repeat. Dedupe on the nonce,
 * never on the signature bytes, because a DER signature can be re-encoded (high-S) into different bytes that still verify.
 */
export function verifySigned<S extends Envelope, R extends string = never>(
  input: ProofInput,
  keys: KeyRing,
  now: number,
  aud: string,
  kind: StatementKind<S, R>,
): Verified<S, R> {
  try {
    return verifyChecked(input, keys, now, aud, kind);
  } catch {
    return { ok: false, refusal: "malformed" };
  }
}

function verifyChecked<S extends Envelope, R extends string>(input: ProofInput, keys: KeyRing, now: number, aud: string, kind: StatementKind<S, R>): Verified<S, R> {
  if (typeof input.statementB64 !== "string" || typeof input.signatureB64 !== "string") return { ok: false, refusal: "malformed" };
  if (!Number.isFinite(now) || typeof aud !== "string") return { ok: false, refusal: "malformed" };
  const bytes = decodeBase64url(input.statementB64);
  const signature = decodeBase64url(input.signatureB64);
  if (bytes === undefined || signature === undefined || bytes.length > MAX_STATEMENT_BYTES) return { ok: false, refusal: "malformed" };
  if (keys.size === 0) return { ok: false, refusal: "unknown-key" };
  const [signer] = signingKeys(keys, bytes, signature);
  if (signer === undefined) return { ok: false, refusal: "bad-signature" };
  const statement = parseStatement(bytes, kind.schema);
  if (statement === undefined) return { ok: false, refusal: "malformed" };
  const refusal = envelopeRefusal(statement, signer, now, aud) ?? kind.refusal(statement);
  return refusal === undefined ? { ok: true, statement, keyId: signer } : { ok: false, refusal };
}
