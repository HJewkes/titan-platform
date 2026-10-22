import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** In serve's state dir: what the A17 scan matches against, so the scan never holds the token itself. */
export const BOT_FINGERPRINT_FILE = "bot-token.sha256";

const HEX_SHA256 = /^[0-9a-f]{64}$/;

export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Written 0600 through a rename, so a scan never reads half a file. With no token the stale file goes: a scan then
 * says "no fingerprint" rather than checking against a token serve no longer holds.
 */
export function publishFingerprint(stateDir: string, fingerprint: string | undefined): void {
  const file = join(stateDir, BOT_FINGERPRINT_FILE);
  if (fingerprint === undefined) return rmSync(file, { force: true });
  mkdirSync(stateDir, { recursive: true });
  const partial = `${file}.${process.pid}.partial`;
  writeFileSync(partial, `${fingerprint}\n`, { mode: 0o600 });
  chmodSync(partial, 0o600);
  renameSync(partial, file);
}

/** An absent, unreadable or malformed file reads as no fingerprint, never as an empty one that matches nothing. */
export function readFingerprint(file: string): string | undefined {
  try {
    const text = readFileSync(file, "utf8").trim();
    return HEX_SHA256.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}
