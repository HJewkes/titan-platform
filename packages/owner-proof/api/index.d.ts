import { KeyObject } from 'node:crypto';
import { z } from 'zod';

/** The refusals the core itself returns; a statement kind may add its own. */
type Refusal = "bad-signature" | "unknown-key" | "expired" | "not-yet-valid" | "window-too-long" | "wrong-aud" | "malformed";
type Verified<S, R extends string = never> = {
    ok: true;
    statement: S;
    keyId: string;
} | {
    ok: false;
    refusal: Refusal | R;
};
/** What every statement type shares. */
interface Envelope {
    aud: string;
    keyId: string;
    iat: number;
    exp: number;
}
/** One statement type: its schema, which must pin a `type` literal, and the checks only that type knows. */
interface StatementKind<S extends Envelope, R extends string = never> {
    schema: z.ZodType<S>;
    refusal: (statement: S) => Refusal | R | undefined;
}
interface ProofInput {
    statementB64: string;
    signatureB64: string;
}
/** Installed owner public keys by key id. */
type KeyRing = ReadonlyMap<string, KeyObject>;
/** Sorted-key JSON, so a digest does not depend on the order a payload's keys were written in. Throws past the depth bound. */
declare function canonical(value: unknown, depth?: number): string;
/** The first 16 hex characters of sha256 over the key's SPKI DER. */
declare function keyIdOf(publicKey: KeyObject): string;
/** Builds the key ring from public keys; a key that is not ECDSA P-256 is an error, never skipped silently. */
declare function keyRing(keys: readonly (KeyObject | string)[]): KeyRing;
/**
 * Verifies an owner-signed statement: ECDSA P-256 SHA-256 DER over the received statement bytes first, then the parse,
 * then the window (at most 300 s, 30 s expiry skew, 60 s issue skew), the audience and the kind's own checks. `now` is
 * unix seconds. It never throws; every doubt is a refusal.
 *
 * Nonce replay needs stored state, so the caller records `statement.nonce` and refuses a repeat. Dedupe on the nonce,
 * never on the signature bytes, because a DER signature can be re-encoded (high-S) into different bytes that still verify.
 */
declare function verifySigned<S extends Envelope, R extends string = never>(input: ProofInput, keys: KeyRing, now: number, aud: string, kind: StatementKind<S, R>): Verified<S, R>;

export { type Envelope, type KeyRing, type ProofInput, type Refusal, type StatementKind, type Verified, canonical, keyIdOf, keyRing, verifySigned };
