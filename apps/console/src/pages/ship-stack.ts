import type { Manifest, Question } from "../../server/round-schema.js";

/**
 * Stacked rounds (decision 95(3)), read as the harness builder writes them (round-rules.ts): a frame of a base PR no question
 * asks about is context, not under review, and its label says so; a PR stacked on another PR of the round ships after it.
 * A round built by the harness already carries the labels, so each prefix is added only where it is missing.
 */
type StackedOn = NonNullable<Manifest["stackedOn"]>;
type RoundSection = NonNullable<Manifest["sections"]>[number];

interface StackBase {
  key: string;
  pr: number;
  prefix: string;
}

const TITLE_PR = /^(?:([^\s#]+\/[^\s#]+))?#(\d+)\b/;
const keyOf = (on: StackedOn): string => `${on.repo}#${on.pr}`;

/** The round's own base, then each PR group's; a group's label wins when it names the round's base too. */
function stackBases(manifest: Manifest): StackBase[] {
  const round = manifest.stackedOn ? [{ key: keyOf(manifest.stackedOn), pr: manifest.stackedOn.pr, prefix: `base PR #${manifest.stackedOn.pr}, not under review: ` }] : [];
  const groups = (manifest.prGroups ?? []).flatMap(({ stackedOn }) =>
    stackedOn ? [{ key: keyOf(stackedOn), pr: stackedOn.pr, prefix: `rendered on #${stackedOn.pr} at ${stackedOn.headSha.slice(0, 7)}, context, not under review: ` }] : [],
  );
  return [...new Map([...round, ...groups].map((base) => [base.key, base])).values()];
}

/** The PR a section is about: its PR group, else its questions' `page`, else the `#n` its title opens with. */
function sectionPr(manifest: Manifest, section: RoundSection): string | undefined {
  const grouped = manifest.prGroups?.find((group) => group.sectionIds.includes(section.id));
  if (grouped) return grouped.pr;
  const page = section.questionIds.flatMap((id) => manifest.questions.find((question) => question.id === id)?.page ?? [])[0];
  if (page) return page;
  const match = TITLE_PR.exec(section.title);
  if (!match) return undefined;
  const [, repo, pr] = match;
  return repo ? `${repo}#${pr}` : (manifest.questions.flatMap((question) => question.page ?? []).find((known) => known.endsWith(`#${pr}`)) ?? `#${pr}`);
}

/** Each frame of a stacked base no question asks about, with the label prefix that marks it context. */
export function stackedPrefixes(manifest: Manifest): ReadonlyMap<string, string> {
  const prefixes = new Map<string, string>();
  for (const base of stackBases(manifest)) {
    if (manifest.questions.some((question) => question.page === base.key)) continue;
    const isBase = (pr: string | undefined) => pr === base.key || pr === `#${base.pr}`;
    manifest.sections
      .filter((section) => isBase(sectionPr(manifest, section)))
      .flatMap((section) => section.variantKeys)
      .forEach((key) => prefixes.set(key, base.prefix));
  }
  return prefixes;
}

export function stackedLabel(prefixes: ReadonlyMap<string, string>, key: string, label: string): string {
  const prefix = prefixes.get(key);
  return prefix && !label.startsWith(prefix) ? prefix + label : label;
}

/** The PR a Ship question's PR ships after: the one its group is stacked on, when that is a PR group of this round. Same repo, as `#n`. */
export function shipsAfter(manifest: Manifest, question: Question): string | undefined {
  if (question.kind !== "pick-one" || question.merge === undefined) return undefined;
  const { repo, pr } = question.merge;
  const on = manifest.prGroups?.find((group) => group.pr === `${repo}#${pr}`)?.stackedOn;
  const holder = on && keyOf(on);
  if (holder === undefined || !manifest.prGroups?.some((group) => group.pr === holder)) return undefined;
  return holder.startsWith(`${repo}#`) ? holder.slice(repo.length) : holder;
}
