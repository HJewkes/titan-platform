import type { ReviewTarget, ReviewerAgent } from "./review.js";
import type { Registration } from "./store.js";

/** Who Shepherd registered as opening the PR; it ties a seat reviewer to the PR when the reviewer's transcript shows nothing. */
export interface PrOwner {
  implementer: string;
  branch: string | null;
}

/** The PR's registered owner; a store the host has not bound, or no registration, is no owner. */
export function registeredOwner(store: { get(): { byPr(repo: string, pr: number): Pick<Registration, "implementer" | "branch"> | undefined } }, target: ReviewTarget): PrOwner | undefined {
  try {
    const registration = store.get().byPr(target.repo, target.pr);
    return registration && { implementer: registration.implementer, branch: registration.branch };
  } catch {
    return undefined;
  }
}

/** A seat check's target with the PR's registered owner; absent when Shepherd holds no registration for it. */
export type SeatTarget = ReviewTarget & { owner?: PrOwner };

/** A roster row as the factory's dispatch lists it; `cwd` is where agent-chat started the agent. */
export type SeatRow = ReviewerAgent & { cwd?: string };

const leaf = (path: string): string => path.replace(/\/+$/, "").split("/").at(-1)?.toLowerCase() ?? "";

/**
 * What the roster says without the transcript. `own`: a row's name stem (`stemOf`, the `<implementer>` of `<implementer>-review`) or working directory is the
 * PR's implementer's or branch's. `other`: a working directory that is some other agent's, not the repo's shared checkout.
 * `none`: no registration, or no working directory, says either.
 */
export function rosterTie(target: SeatTarget, rows: readonly SeatRow[], stemOf: (row: SeatRow) => string): "own" | "other" | "none" {
  if (target.owner === undefined) return "none";
  const owner = new Set([target.owner.implementer, target.owner.branch ?? ""].map(leaf).filter((key) => key !== ""));
  const dirs = rows.flatMap((row) => (row.cwd ? [leaf(row.cwd)] : [])).filter((dir) => dir !== "" && dir !== leaf(target.repo));
  if ([...rows.map((row) => leaf(stemOf(row))), ...dirs].some((key) => owner.has(key))) return "own";
  return dirs.length > 0 ? "other" : "none";
}

/** `registeredOwner` over a store, for a step that hands the seat check its target's owner. */
export const ownerIn = (store: Parameters<typeof registeredOwner>[0]) => (target: ReviewTarget) => registeredOwner(store, target);
