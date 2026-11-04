import type { GitHubPort, RepoEntry, RepoSlug } from "@titan-design/github";
import { z } from "zod";
import { statusOf } from "../required-checks.js";
import { registryClosureMembers, type ClosureMembers } from "./closure-members.js";
import { claimedRows, type Attestation } from "../registry/attest.js";

/** One file per PR, `<pr>.json`, so two PRs that each add rows never touch the same file (TP-4745). */
export const ATTESTATIONS_DIR = "products/factory/src/registry/attestations";
/** The single file every PR appended to before TP-4745; a ref with no attestations directory still holds its rows here. */
export const LEGACY_ATTESTATIONS_PATH = "products/factory/src/registry/attestations.json";
const PR_FILE = /^[1-9][0-9]*\.json$/;

/** The path a PR writes its own rows to. */
export const attestationsFileOf = (pr: number): string => `${ATTESTATIONS_DIR}/${pr}.json`;

/** The PR's author writes these files, so a row in any other shape makes the whole read unread rather than partly claimed. */
const AttestationsFile = z.array(z.strictObject({ step: z.string().min(1), closure: z.string().min(1), pr: z.number().int().positive() }));

/** A directory entry no PR file could be, or a listed file that reads as absent: the layout itself is malformed. */
class MalformedLayout extends Error {}

interface ClaimRefs {
  repo: RepoSlug;
  base: string;
  head: string;
}

type ClaimsRead = { claimed: Attestation[] } | { unread: string };

/** The ref's PR files, or undefined when the ref has no attestations directory; anything else in it is malformed. */
async function listingAt(port: GitHubPort, repo: RepoSlug, ref: string): Promise<RepoEntry[] | undefined> {
  const entries = await port.listFiles(repo, ATTESTATIONS_DIR, ref);
  const stray = entries?.find((entry) => !PR_FILE.test(entry.path.slice(ATTESTATIONS_DIR.length + 1)));
  if (stray) throw new MalformedLayout(`${stray.path} is not a <pr>.json file`);
  return entries ?? undefined;
}

/** Every row of `paths` at `ref`, a listed file read as absent being malformed; an absent legacy file holds no rows. */
async function rowsOf(port: GitHubPort, repo: RepoSlug, ref: string, paths: readonly string[]): Promise<Attestation[]> {
  const files = await Promise.all(paths.map(async (path) => ({ path, file: await port.getFile(repo, path, ref) })));
  return files.flatMap(({ path, file }) => {
    if (file === null && path !== LEGACY_ATTESTATIONS_PATH) throw new MalformedLayout(`${path} is listed but absent`);
    return file === null ? [] : AttestationsFile.parse(JSON.parse(file.content));
  });
}

/** The paths to read at a ref: its PR files, or the legacy file where the ref predates the directory. */
const pathsOf = (entries: readonly RepoEntry[] | undefined): string[] => (entries === undefined ? [LEGACY_ATTESTATIONS_PATH] : entries.map((entry) => entry.path));

/**
 * The union of rows at the base and the head. A head file with the base file's blob holds only rows the base holds, so
 * no row of it can be claimed and it is not read again.
 */
async function bothSides(port: GitHubPort, { repo, base, head }: ClaimRefs): Promise<[Attestation[], Attestation[]]> {
  const [baseEntries, headEntries] = await Promise.all([listingAt(port, repo, base), listingAt(port, repo, head)]);
  const unchanged = new Set((baseEntries ?? []).map((entry) => `${entry.path}\0${entry.blobSha}`));
  const headChanged = headEntries?.filter((entry) => !unchanged.has(`${entry.path}\0${entry.blobSha}`));
  return Promise.all([rowsOf(port, repo, base, pathsOf(baseEntries)), rowsOf(port, repo, head, pathsOf(headChanged))]);
}

const malformed = (error: unknown): boolean => error instanceof z.ZodError || error instanceof SyntaxError || error instanceof MalformedLayout;

/** The rows the head adds or changes against the base; a listing, read or parse that fails on either side names the rows unread. */
export async function readClaims(port: GitHubPort, refs: ClaimRefs): Promise<ClaimsRead> {
  try {
    const [before, after] = await bothSides(port, refs);
    return { claimed: claimedRows(before, after) };
  } catch (error) {
    return { unread: `${ATTESTATIONS_DIR} is unreadable: ${malformed(error) ? "malformed" : statusOf(error)}` };
  }
}

/** The closure files the PR changed; a step the registry does not know, or a closure that cannot be read, lists none. */
function changedMembers(members: ClosureMembers, step: string, changed: ReadonlySet<string>): string[] {
  try {
    return (members(step) ?? []).filter((path) => changed.has(path));
  } catch {
    return [];
  }
}

/** The claims the reviewer's brief asks about, each with the closure files this PR changed; an unreadable PR or file asks nothing, and the merge guard reads it again. */
export async function briefClaimsAt(
  port: GitHubPort,
  target: { repo: RepoSlug; pr: number; head: string },
  members: ClosureMembers = registryClosureMembers,
): Promise<{ attestClaims?: { step: string; closure: string; changedFiles?: string[] }[] }> {
  try {
    const { baseRef } = await port.getPr(target.repo, target.pr);
    const read = await readClaims(port, { repo: target.repo, base: baseRef, head: target.head });
    if ("unread" in read || read.claimed.length === 0) return {};
    const changed = new Set((await port.listPrFiles(target.repo, target.pr).catch(() => [])).map(({ path }) => path));
    return {
      attestClaims: read.claimed.map(({ step, closure }) => {
        const changedFiles = changedMembers(members, step, changed);
        return { step, closure, ...(changedFiles.length > 0 && { changedFiles }) };
      }),
    };
  } catch {
    return {};
  }
}

/** What the attestation judge came to at a head, as the merge guard reads it; absent means the head claims no row, and `deploySkew` that it waits for a deploy. */
export type AttestDecided = { unmet: readonly { step: string; why: string }[] } | { unread: string } | { deploySkew: string };

/** The merge-guard row an attest judgment gates on, and why. */
interface AttestGate {
  row: "attest-unmet" | "attest-deploy-skew";
  reason: string;
}

/**
 * A head that adds or changes an attestation row merges only when an independent reviewer's MERGE at that head attests
 * each row, and the adversary's too where the class has one; claims that cannot be read gate as unmet. A read that waits
 * for a deploy gates on its own row, which land waits out at the head (TP-4752).
 */
export function attestGate(attest: AttestDecided | undefined): AttestGate | undefined {
  if (attest === undefined) return undefined;
  if ("deploySkew" in attest) return { row: "attest-deploy-skew", reason: `attestation waits: ${attest.deploySkew}` };
  if ("unread" in attest) return { row: "attest-unmet", reason: `attestation unmet: unread: ${attest.unread}` };
  return attest.unmet.length === 0 ? undefined : { row: "attest-unmet", reason: `attestation unmet: ${attest.unmet.map(({ step, why }) => `${step}: ${why}`).join("; ")}` };
}

/** The steps the `shepherd/review` check names as unmet; an unread file names itself, and a wait for a deploy names none. */
export function attestUnmetSteps(attest: AttestDecided | undefined): string[] {
  if (attest === undefined || "deploySkew" in attest) return [];
  return "unread" in attest ? ["attestations unread"] : attest.unmet.map(({ step }) => step);
}
