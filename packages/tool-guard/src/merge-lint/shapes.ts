export type ShapeId = "gh-pr-merge" | "rest-pr-merge" | "rest-branch-merge" | "graphql-merge" | "octokit-merge";

export interface Shape {
  id: ShapeId;
  /** Global, so `matchAll` finds every hit; `\s+` between words lets a match cross a soft-wrapped line. */
  pattern: RegExp;
  /** True when the text right after a match cancels it. */
  cancelledBy?: RegExp;
}

const SEGMENT = String.raw`[^\s/"'` + "`" + String.raw`]+`;
const GH_GLOBAL_FLAG = String.raw`(?:\s+-{1,2}\w[\w-]*(?:=\S+|\s+[^\s-]\S*)?)`;

const FLAG = String.raw`-{1,2}\w[\w-]*(?:=\S+)?`;
const VALUE_FLAG = String.raw`(?:-b|--body|-F|--body-file|-t|--subject|--match-head-commit|-A|--author-email|-R|--repo)\s+\S+`;
const SELECTOR = String.raw`(?:#?\d+|https?://\S+)`;
const FLAG_RUN = String.raw`(?:\s+(?:${VALUE_FLAG}|${FLAG}))*`;
const CANCELLED_BY_DISABLE_AUTO = new RegExp(String.raw`^${FLAG_RUN}(?:\s+${SELECTOR}${FLAG_RUN})?\s+--disable-auto(?![\w-])`);

/** Case-insensitive like tool-guard, which folds case before it classifies. */
export const SHAPES: readonly Shape[] = [
  {
    id: "gh-pr-merge",
    pattern: new RegExp(String.raw`(?<![\w-])gh${GH_GLOBAL_FLAG}*\s+pr\s+merge(?![\w-])`, "gi"),
    // `--disable-auto` only cancels an auto-merge, as in tool-guard's families/merge.ts.
    // Only flags and one PR selector may sit between `merge` and `--disable-auto`; any other word means the flag is prose or a later command.
    cancelledBy: CANCELLED_BY_DISABLE_AUTO,
  },
  { id: "rest-pr-merge", pattern: new RegExp(String.raw`pulls/${SEGMENT}/merge(?![\w-])`, "gi") },
  { id: "rest-branch-merge", pattern: new RegExp(String.raw`repos/${SEGMENT}(?:/${SEGMENT})?/merges(?![\w-])`, "gi") },
  // GraphQL is case-sensitive.
  { id: "graphql-merge", pattern: /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest)\b/g },
  { id: "octokit-merge", pattern: /\bpulls\.merge\s*\(/g },
];

export interface ShapeHit {
  shape: ShapeId;
  /** Character offset where the match starts. */
  index: number;
}

export function findHits(text: string): ShapeHit[] {
  const hits: ShapeHit[] = [];
  for (const shape of SHAPES) {
    for (const match of text.matchAll(shape.pattern)) {
      const rest = text.slice(match.index + match[0].length);
      if (shape.cancelledBy?.test(rest)) continue;
      hits.push({ shape: shape.id, index: match.index });
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}
