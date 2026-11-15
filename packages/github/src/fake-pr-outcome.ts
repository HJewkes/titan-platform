import type { FakeGitHub } from "./fake-types.js";
import type { PrOutcome } from "./pr-outcome.js";
import type { PullRequest } from "./port-types.js";

/** The seeded outcome as a copy; unseeded, the PR's own state. `prOf` throws 404 for a PR the fake lacks. */
export function fakePrOutcome(fake: FakeGitHub, number: number, prOf: (number: number) => PullRequest): PrOutcome {
  const seeded = fake.outcomes.get(number);
  if (seeded) return { ...seeded, reviews: seeded.reviews.map((review) => ({ ...review })), commitDates: [...seeded.commitDates] };
  const pr = prOf(number);
  return { state: pr.merged ? "merged" : pr.state, mergedAt: pr.mergedAt, closedAt: null, reviews: [], commitDates: [], truncated: false };
}
