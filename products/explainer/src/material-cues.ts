import type { MaterialFact } from "./material-facts.js";

/**
 * A cue marks a fact as one kind of material: a word or phrase in its text, or a gather `kind`. The lexicon is
 * code, not a model call (plan §A.3 step 1 is $0), so the same facts always give the same map.
 */
interface Cue {
  pattern?: RegExp;
  kinds?: readonly string[];
  /** Also holds when the fact carries this gather field. */
  field?: "group" | "verdict";
}

const CUES = {
  tension: { pattern: /\b(but|however|yet|although|though|despite|instead|contradict\w*|tension|trade-?offs?)\b/, kinds: ["gotcha", "should-not"] },
  change: { pattern: /\b(before|after|no longer|used to|went from|replac\w*|chang\w*|from \S+ to)\b|→/ },
  mechanism: { pattern: /\b(algorithm|loop|pipeline|comput\w*|simulat\w*|state machine|pars(es|er|ing)|render(s|er|ing)?|execut\w*|runs?)\b|`[^`]+`/, kinds: ["entry-point"] },
  flow: { pattern: /\b(calls?|sends?|reads?|writes?|emits?|passes|returns?|hands? (off|over)|flows?|requests?|responds?)\b|->|→/ },
  parallel: { pattern: /\b(checks?|lints?|gates?|findings?|verifiers?|rules?|features?|issues?|risks?|bugs?)\b/, kinds: ["feature", "gotcha", "capability", "guard"], field: "group" },
  pain: { pattern: /\b(pain\w*|hurts?|problem|manual\w*|by hand|by eye|slow|toil|blocked|tedious|error-prone)\b/, kinds: ["pain"] },
  anomaly: { pattern: /\b(bugs?|contradict\w*|surpris\w*|unexpected\w*|should(n'?t| not)|anomal\w*|regress\w*|silently|impossible)\b/, kinds: ["gotcha"] },
  decision: { pattern: /\b(decid\w*|decision|approv\w*|adopt|adapt|avoid|recommend\w*|verdict|crib|should (we|titan|you|the owner)|waiting on|sign-?off)\b/, kinds: ["integration-rec", "should-not"], field: "verdict" },
  sequence: { pattern: /\b(first|then|next|finally|afterwards|step \d+)\b/ },
  attempt: { pattern: /\b(tried|attempt\w*|retried|workaround|gave up|first try)\b/ },
  failure: { pattern: /\b(fail\w*|broke|broken|crash\w*|didn'?t work|revert\w*|rolled back)\b/ },
  experiment: { pattern: /\b(measur\w*|benchmark\w*|experiment\w*|ablation|baseline|trial|a\/b|control group|n\s*=\s*\d+)\b/ },
  cascade: { pattern: /\b(cascad\w*|knock-on|ripple\w*|led to|leads to|caused|triggered|in turn|downstream)\b/ },
  transition: { pattern: /\b(moved|closed|merged|shipped|landed|opened|reopened|unblocked|blocked|done|in progress|filed)\b/ },
  dated: { pattern: /\b\d{4}-\d{2}-\d{2}\b|\b(day|week|month|round|sprint) \d+\b|\bq[1-4]\b/ },
  purpose: { pattern: /\bis an? (\w+ ){0,3}(skill|library|tool|framework|service|cli|package|repo|app|engine|plugin)\b/, kinds: ["what-it-is"] },
  entry: { pattern: /\b(entry points?|commands?|cli|main|starts?)\b/, kinds: ["entry-point"] },
  layout: { pattern: /\b(packages?|modules?|director(y|ies)|folders?|layers?|layout)\b/, kinds: ["shape"] },
  readFirst: { pattern: /\b(read first|start reading|readme)\b/, kinds: ["read-first"] },
} as const satisfies Record<string, Cue>;

export type CueId = keyof typeof CUES;

/** A fact a cue marked, and what marked it: the matched words or the gather field, never the rest of the text. */
export interface CueHit {
  fact: string;
  by: string;
}

/** `TP-123`-style ids; case-sensitive, so it reads the original text. */
const TASK_REF = /\b[A-Z]{2,}-\d+\b/;
const WORD_NUMBERS: Record<string, number> = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const ROUNDS = /\b(\d+|three|four|five|six|seven|eight|nine|ten) (review )?rounds\b|\bround (\d+)\b/g;
/** A number that is not part of an id, a line reference or a version: `F01`, `S:40`, `1.2.3`. */
const NUMBER = /(?<![\w.:-])\d+(?:\.\d+)?(?![\w.]*\d)/g;

function cueHit(cue: Cue, fact: MaterialFact, lower: string): string | undefined {
  const match = cue.pattern ? lower.match(cue.pattern) : null;
  if (match) return match[0];
  if (fact.kind && cue.kinds?.includes(fact.kind)) return `kind:${fact.kind}`;
  if (cue.field && fact[cue.field]) return `${cue.field}:${fact[cue.field]}`;
  return undefined;
}

export const numbersIn = (text: string): number[] => [...text.matchAll(NUMBER)].map((m) => Number(m[0]));

/** The most review rounds a fact names; three or more is the saga (story-structure §4). */
export function roundsIn(text: string): number {
  const counts = [...text.toLowerCase().matchAll(ROUNDS)].map((m) => {
    const word = m[1] ?? m[3] ?? "0";
    return WORD_NUMBERS[word] ?? Number(word);
  });
  return Math.max(0, ...counts);
}

export type CueTable = Record<CueId | "taskRef", CueHit[]>;

/** Every cue's hits over the facts, in fact order. */
export function tagFacts(facts: readonly MaterialFact[]): CueTable {
  const table = Object.fromEntries([...Object.keys(CUES), "taskRef"].map((id) => [id, [] as CueHit[]])) as CueTable;
  for (const fact of facts) {
    const lower = fact.text.toLowerCase();
    for (const [id, cue] of Object.entries(CUES) as [CueId, Cue][]) {
      const by = cueHit(cue, fact, lower);
      if (by !== undefined) table[id].push({ fact: fact.id, by });
    }
    const ref = fact.text.match(TASK_REF);
    if (ref) table.taskRef.push({ fact: fact.id, by: ref[0] });
  }
  return table;
}
