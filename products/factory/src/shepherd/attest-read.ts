import type { GitHubPort, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import { statusOf } from "../required-checks.js";
import { claimedRows, type Attestation } from "../registry/attest.js";

export const ATTESTATIONS_PATH = "products/factory/src/registry/attestations.json";

/** The PR's author writes this file, so a row in any other shape makes the whole file unread rather than partly claimed. */
const AttestationsFile = z.array(z.strictObject({ step: z.string().min(1), closure: z.string().min(1), pr: z.number().int().positive() }));

interface ClaimRefs {
  repo: RepoSlug;
  base: string;
  head: string;
}

type ClaimsRead = { claimed: Attestation[] } | { unread: string };

/** A file absent at a ref holds no rows there. */
async function rowsAt(port: GitHubPort, repo: RepoSlug, ref: string): Promise<Attestation[]> {
  const file = await port.getFile(repo, ATTESTATIONS_PATH, ref);
  return file === null ? [] : AttestationsFile.parse(JSON.parse(file.content));
}

/** The rows the head adds or changes against the base; a read or parse that fails on either side names the file unread. */
export async function readClaims(port: GitHubPort, { repo, base, head }: ClaimRefs): Promise<ClaimsRead> {
  try {
    const [before, after] = await Promise.all([rowsAt(port, repo, base), rowsAt(port, repo, head)]);
    return { claimed: claimedRows(before, after) };
  } catch (error) {
    return { unread: `${ATTESTATIONS_PATH} is unreadable: ${error instanceof z.ZodError || error instanceof SyntaxError ? "malformed" : statusOf(error)}` };
  }
}

/** The claims the reviewer's brief asks about; an unreadable PR or file asks nothing, and the merge guard reads it again. */
export async function briefClaimsAt(port: GitHubPort, target: { repo: RepoSlug; pr: number; head: string }): Promise<{ attestClaims?: { step: string; closure: string }[] }> {
  try {
    const { baseRef } = await port.getPr(target.repo, target.pr);
    const read = await readClaims(port, { repo: target.repo, base: baseRef, head: target.head });
    if ("unread" in read || read.claimed.length === 0) return {};
    return { attestClaims: read.claimed.map(({ step, closure }) => ({ step, closure })) };
  } catch {
    return {};
  }
}

/** What the attestation judge came to at a head, as the merge guard reads it; absent means the head claims no row. */
export type AttestDecided = { unmet: readonly { step: string; why: string }[] } | { unread: string };

/**
 * A head that adds or changes an attestation row merges only when an independent reviewer's MERGE at that head attests
 * each row, and the adversary's too where the class has one; claims that cannot be read gate as unmet.
 */
export function attestUnmetReason(attest: AttestDecided | undefined): string | undefined {
  if (attest === undefined) return undefined;
  if ("unread" in attest) return `attestation unmet: unread: ${attest.unread}`;
  return attest.unmet.length === 0 ? undefined : `attestation unmet: ${attest.unmet.map(({ step, why }) => `${step}: ${why}`).join("; ")}`;
}
