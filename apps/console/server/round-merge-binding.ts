/**
 * A pick-one that offers a merge must say which PR head it merges. Its answer is the owner's merge approval
 * (decision 489), so a "Merge #N" option, a "Ship" option or a signsOff naming "#N at <sha>" without a `merge`
 * binding is refused, and so is a binding whose pr or head disagrees with what the wording names.
 *
 * Only where a round is authored (`round-import.ts`): a round already in the rounds dir stays listed and answerable,
 * flagged unbound, because an owner may be mid-answer on it and an unbound pick taps no merge.
 * Product-side because `review-schema-0.3/` is vendored and never edited; review-schema takes it upstream.
 */
import type * as reviewSchema from "./review-schema-0.3/index.js";

type Question = reviewSchema.Manifest["questions"][number];
type PickOne = Extract<Question, { kind: "pick-one" }>;

const MERGE_OPTION = /^Merge #(\d+)\b/;
const SHIP_OPTION = /^Ship$/;
const SIGNS_OFF_HEAD = /#(\d+) at ([0-9a-f]{7,})/g;

interface Offer {
  /** The wording that offers the merge, quoted in the problem. */
  text: string;
  pr?: number;
  headPrefix?: string;
}

function offersOf(question: PickOne): Offer[] {
  const options = question.options.flatMap((option): Offer[] => {
    const merge = MERGE_OPTION.exec(option);
    if (merge) return [{ text: `option "${option}"`, pr: Number(merge[1]) }];
    return SHIP_OPTION.test(option) ? [{ text: `option "${option}"` }] : [];
  });
  const signsOff = [...(question.signsOff ?? "").matchAll(SIGNS_OFF_HEAD)].map(
    ([match, pr, headPrefix]): Offer => ({ text: `signsOff "${match}"`, pr: Number(pr), headPrefix }),
  );
  return [...options, ...signsOff];
}

function disagreement(offer: Offer, merge: NonNullable<PickOne["merge"]>): string | null {
  if (offer.pr !== undefined && offer.pr !== merge.pr) return `names #${offer.pr} but its merge binding is #${merge.pr}`;
  if (offer.headPrefix !== undefined && !merge.headSha.startsWith(offer.headPrefix)) {
    return `names head ${offer.headPrefix} but its merge binding is at ${merge.headSha}`;
  }
  return null;
}

function questionProblems(question: PickOne): string[] {
  const offers = offersOf(question);
  const [first] = offers;
  if (first === undefined) return [];
  const { merge } = question;
  if (!merge) {
    return [`question ${question.id}: ${first.text} offers a merge, so it needs a merge binding {repo, pr, headSha, ship}`];
  }
  return offers.flatMap((offer) => {
    const why = disagreement(offer, merge);
    return why ? [`question ${question.id}: ${offer.text} ${why}`] : [];
  });
}

export function mergeBindingProblems(questions: readonly Question[]): string[] {
  return questions.flatMap((question) => (question.kind === "pick-one" ? questionProblems(question) : []));
}

/** True when a pick-one offers a merge with no binding at all: its answer is recorded, but no merge tap follows. */
export function hasUnboundMergeOffer(questions: readonly Question[]): boolean {
  return questions.some((question) => question.kind === "pick-one" && question.merge === undefined && offersOf(question).length > 0);
}
