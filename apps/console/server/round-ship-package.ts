/**
 * A Ship round is one clean main-vs-head package (owner rule, TP-3520): one merge-bound question, every image frame
 * paired with its main (base) frame or marked new at head, and no exploration content. Alternatives side by side
 * (A/B columns, proposals) go to a separate feedback round, so `round-import.ts` refuses a Ship round that carries them.
 *
 * Only where a round is authored, like `round-merge-binding.ts`: a round already in the rounds dir stays listed.
 */
import type { Manifest } from "./round-schema.js";

type Variant = Manifest["variants"][number];
/** The frames.json record fields this check reads, keyed by frame key. */
type IndexedFrame = { key: string; base?: unknown };

/** "(new at head)" is what the review harness writes into the label of a frame with no main counterpart. */
const NEW_AT_HEAD_LABEL = /\bnew at head\b/i;
/**
 * Exploration is alternatives shown side by side, not where a story lives: a lab-only PR ships its lab story, new at head.
 * The words mark an alternative in a variant key or label: an A/B pair, a proposal, an alpha.
 */
const EXPLORATION_WORDS = /\bA\/B\b|\bproposals?\b|\balpha\b/i;

const isMergeBound = (question: Manifest["questions"][number]): boolean => question.kind === "pick-one" && question.merge !== undefined;

/** A new frame has no main counterpart and a removed one no head; a CI packet marks both with `change`. */
const isOneSided = (variant: Variant): boolean => variant.change === "new" || variant.change === "removed" || NEW_AT_HEAD_LABEL.test(variant.label);

function explorationMarker(variant: Variant): string | null {
  if (variant.alternate !== undefined) return `alternate "${variant.alternate}" (an A/B column)`;
  const word = EXPLORATION_WORDS.exec(variant.key) ?? EXPLORATION_WORDS.exec(variant.label);
  return word ? `"${word[0]}" in its key or label` : null;
}

function unpairedProblems(variants: readonly Variant[], frames: readonly IndexedFrame[]): string[] {
  const paired = new Set(frames.filter((frame) => frame.base !== undefined).map((frame) => frame.key));
  return variants
    .filter((variant) => variant.image !== undefined && variant.baseImage === undefined && !paired.has(variant.key) && !isOneSided(variant))
    .map((variant) => `frame ${variant.key} has no main frame: give it a frames.json base or a baseImage, or mark it new at head (change "new" or "(new at head)" in its label)`);
}

/** Empty for a round with no merge-bound question; otherwise each problem names the question, frame or variant and the rule. */
export function shipPackageProblems(manifest: Manifest, frames: readonly IndexedFrame[]): string[] {
  const ships = manifest.questions.filter(isMergeBound);
  if (ships.length === 0) return [];
  const problems = ships.length > 1 ? [`a Ship round binds one merge, not ${ships.length} (${ships.map((question) => question.id).join(", ")})`] : [];
  const exploration = manifest.variants.flatMap((variant) => {
    const marker = explorationMarker(variant);
    return marker ? [`variant ${variant.key} is exploration (${marker}): it belongs in a feedback round`] : [];
  });
  return [...problems, ...exploration, ...unpairedProblems(manifest.variants, frames)];
}
