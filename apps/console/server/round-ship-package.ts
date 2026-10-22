/**
 * A Ship round is one clean main-vs-head package (owner rule, TP-3520): one merge-bound question per PR group, every image frame
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

type PickOne = Extract<Manifest["questions"][number], { kind: "pick-one" }>;
type MergeBound = PickOne & { merge: NonNullable<PickOne["merge"]> };

const isMergeBound = (question: Manifest["questions"][number]): question is MergeBound => question.kind === "pick-one" && question.merge !== undefined;

/** One problem for a merge with no PR group of its own, at another head, or asked outside that group's sections. */
function groupProblem(manifest: Manifest, ship: MergeBound): string | null {
  const key = `${ship.merge.repo}#${ship.merge.pr}`;
  const group = manifest.prGroups?.find((candidate) => candidate.pr === key);
  if (group === undefined) return `question ${ship.id} ships ${key}, which has no PR group`;
  if (group.headSha !== ship.merge.headSha) return `question ${ship.id} ships ${key} at ${ship.merge.headSha}, its PR group is at ${group.headSha}`;
  const asked = manifest.sections.some((section) => group.sectionIds.includes(section.id) && section.questionIds.includes(ship.id));
  return asked ? null : `question ${ship.id} is not in a section of the ${key} PR group`;
}

/** A round binds several merges only as PR groups (TP-3329): one group per merge, at its head, holding its Ship question. */
function multiShipProblems(manifest: Manifest, ships: readonly MergeBound[]): string[] {
  if (ships.length < 2) return [];
  const ids = ships.map((question) => question.id).join(", ");
  if (manifest.prGroups === undefined) return [`a Ship round binds one merge, not ${ships.length} (${ids}), unless each PR has its own prGroups entry`];
  return ships.flatMap((ship) => groupProblem(manifest, ship) ?? []);
}

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
  const problems = multiShipProblems(manifest, ships);
  const exploration = manifest.variants.flatMap((variant) => {
    const marker = explorationMarker(variant);
    return marker ? [`variant ${variant.key} is exploration (${marker}): it belongs in a feedback round`] : [];
  });
  return [...problems, ...exploration, ...unpairedProblems(manifest.variants, frames)];
}
