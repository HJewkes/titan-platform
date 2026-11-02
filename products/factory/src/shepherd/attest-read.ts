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

export type ClaimsRead = { claimed: Attestation[] } | { unread: string };

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

/** The claims the reviewer's brief asks about; an unreadable file asks nothing, and the merge guard reads it again. */
export async function briefClaimsAt(port: GitHubPort, target: { repo: RepoSlug; pr: number; head: string }): Promise<{ attestClaims?: { step: string; closure: string }[] }> {
  const read = await port.getPr(target.repo, target.pr).then((pr) => readClaims(port, { repo: target.repo, base: pr.baseRef, head: target.head }), (error: unknown) => ({ unread: statusOf(error) }));
  if ("unread" in read || read.claimed.length === 0) return {};
  return { attestClaims: read.claimed.map(({ step, closure }) => ({ step, closure })) };
}
