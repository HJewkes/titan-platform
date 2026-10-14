import type { ReviewTarget, ReviewerAgent } from "./review.js";
import type { Registration } from "./store.js";

/** Who Shepherd registered as opening a PR; it ties a seat reviewer to that PR when the reviewer's transcript shows nothing. */
interface PrOwner {
  implementer: string;
  branch: string | null;
}

/** Another registered PR's owner, with `label` naming that PR in a warning. */
type OtherOwner = PrOwner & { label: string };

/** A seat check's target with the PR's registered owner and every other registration's; both absent when Shepherd holds no registration for it. */
export type SeatTarget = ReviewTarget & { owner?: PrOwner; others?: readonly OtherOwner[] };

/** The store calls a seat check reads; `all` lists every registration, so a reviewer can be matched to a PR other than this one. */
type RegistrationReads = Pick<Registration, "repo" | "pr" | "implementer" | "branch">;
type SeatStore = { get(): { byPr(repo: string, pr: number): RegistrationReads | undefined; all(): readonly RegistrationReads[] } };

const ownerOf = (registration: RegistrationReads): PrOwner => ({ implementer: registration.implementer, branch: registration.branch });

const samePr = (target: ReviewTarget, registration: RegistrationReads) => registration.pr === target.pr && registration.repo.toLowerCase() === target.repo.toLowerCase();

/** The PR's registered owner and every other registration's; a store the host has not bound, a failed read, or no registration is neither. */
export function registeredOwners(store: SeatStore, target: ReviewTarget): Pick<SeatTarget, "owner" | "others"> {
  try {
    const registrations = store.get();
    const registration = registrations.byPr(target.repo, target.pr);
    if (!registration) return {};
    const others = registrations.all().filter((each) => !samePr(target, each));
    return { owner: ownerOf(registration), others: others.map((each) => ({ ...ownerOf(each), label: each.pr === null ? `${each.repo} ${each.branch ?? ""}`.trim() : `${each.repo}#${each.pr}` })) };
  } catch {
    return {};
  }
}

/** A roster row as the factory's dispatch lists it; `cwd` is where agent-chat started the agent, and `transcriptExists` is absent when the port does not say. */
export type SeatRow = ReviewerAgent & { cwd?: string; transcriptExists?: boolean };

/** The name's newest roster row (the last in roster order) when it has no session or no transcript yet; older rows and an absent `transcriptExists` are ignored. */
export function awaitingTranscript(rows: readonly SeatRow[]): SeatRow | undefined {
  const newest = rows.at(-1);
  return newest !== undefined && (newest.sessionId === "" || newest.transcriptExists === false) ? newest : undefined;
}

const leaf = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1)?.toLowerCase() ?? "";

const ownerKeys = (owner: PrOwner): Set<string> => new Set([owner.implementer, owner.branch ?? ""].map(leaf).filter((key) => key !== ""));

/** `own`: a key is this PR's implementer or branch. `other`: a key is another registered PR's, named by `pr`. `none`: no registration says either. */
type Tie = { kind: "own" } | { kind: "other"; pr: string } | { kind: "none"; missing: string };

/**
 * What the roster says without the transcript, matched against Shepherd's registrations and never against a path's shape: each
 * row's name stem (`stemOf`) and the leaf of its working directory, with and without the stem's suffix, unless that directory is the
 * repo's shared checkout. A key no registration owns is no evidence either way.
 */
export function rosterTie(target: SeatTarget, rows: readonly SeatRow[], stemOf: (name: string) => string): Tie {
  const dirs = rows.flatMap((row) => (row.cwd ? [leaf(row.cwd)] : [])).filter((dir) => dir !== "" && dir !== leaf(target.repo));
  const keys = [...new Set([...rows.map((row) => leaf(stemOf(row.name))), ...dirs, ...dirs.map(stemOf)])].filter((key) => key !== "");
  if (target.owner === undefined) return { kind: "none", missing: `Shepherd holds no registration for ${target.repo}#${target.pr}` };
  const owner = ownerKeys(target.owner);
  if (keys.some((key) => owner.has(key))) return { kind: "own" };
  const other = target.others?.find((each) => keys.some((key) => ownerKeys(each).has(key)));
  if (other) return { kind: "other", pr: other.label };
  return { kind: "none", missing: `no registration's implementer or branch is ${keys.map((key) => `"${key}"`).join(" or ")}` };
}

/** `registeredOwners` over a store, for a step that hands the seat check its target's owners. */
export const ownerIn = (store: SeatStore) => (target: ReviewTarget) => registeredOwners(store, target);
