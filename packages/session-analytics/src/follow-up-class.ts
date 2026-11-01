/** Follow-up classes in match order: a brief fix often also reads as a correction, so it is tried first. */
const FOLLOW_UP_PATTERNS = [
  [
    "brief-fix",
    /brief update|correction to your brief|^correction|correction:|ignore (the|my) (earlier|previous)|disregard|scratch that|I was wrong|wrong (repo|branch|worktree|pr|head|base)|you (missed|forgot|skipped|did not|didn't)|re-?read/im,
  ],
  ["poll", /\b(status\?|any (update|progress|news)|where are you|are you (still|done|blocked|stuck|there)|still (working|alive|there|on it)|what'?s your status|report (your )?status)/i],
  [
    "correction",
    /\b(no[,.]? (that|this|not|don't)|don't|do not|stop|wrong|incorrect|actually|instead|why did you|why are you|I said|I asked|not what I|you (forgot|missed|didn't)|undo|revert|that's not|should have|shouldn't have|correction|please don't|never )\b/i,
  ],
] as const satisfies readonly (readonly [string, RegExp])[];

export const FOLLOW_UP_CLASSES = [...FOLLOW_UP_PATTERNS.map(([name]) => name), "other"] as const;
export type FollowUpClass = (typeof FOLLOW_UP_CLASSES)[number];

/** Only the opening of a message is classed, as the self-improve classifier did, so a long quoted brief cannot match. */
const CLASSED_CHARS = 1500;

/** Insights Q6's classifier for a spawner's message to its child. */
export function classifyFollowUp(body: string): FollowUpClass {
  const head = body.slice(0, CLASSED_CHARS);
  return FOLLOW_UP_PATTERNS.find(([, pattern]) => pattern.test(head))?.[0] ?? "other";
}
