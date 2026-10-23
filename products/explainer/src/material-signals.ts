import { roundsIn, type CueHit, type CueId, type CueTable } from "./material-cues.js";
import type { MaterialFact } from "./material-facts.js";

/** What a signal rule saw: whether it holds, and the facts behind it. */
interface SignalEval {
  holds: boolean;
  facts: string[];
}

interface SignalRule {
  rule: string;
  evaluate: (cues: CueTable, facts: readonly MaterialFact[]) => SignalEval;
}

const ids = (hits: readonly CueHit[]): string[] => [...new Set(hits.map((hit) => hit.fact))];
const atLeast = (n: number, hits: readonly CueHit[]): SignalEval => ({ holds: ids(hits).length >= n, facts: ids(hits) });
const both = (a: readonly CueHit[], b: readonly CueHit[]): CueHit[] => a.filter((hit) => b.some((other) => other.fact === hit.fact));

function overview(cues: CueTable): SignalEval {
  const aspects: CueId[] = ["purpose", "entry", "layout", "readFirst"];
  const covered = aspects.filter((aspect) => cues[aspect].length > 0);
  return { holds: covered.length >= 3, facts: ids(covered.flatMap((aspect) => cues[aspect])) };
}

function centralProblem(cues: CueTable): SignalEval {
  const pains = ids(cues.pain).length;
  return { holds: pains >= 1 && pains <= 3, facts: ids(cues.pain) };
}

function attemptsFailed(cues: CueTable): SignalEval {
  return { holds: cues.attempt.length > 0 && cues.failure.length > 0, facts: ids([...cues.attempt, ...cues.failure]) };
}

function experiment(cues: CueTable, facts: readonly MaterialFact[]): SignalEval {
  const stated = new Set(facts.filter((fact) => /\d/.test(fact.text)).map((fact) => fact.id));
  return atLeast(1, cues.experiment.filter((hit) => stated.has(hit.fact)));
}

function rounds(_cues: CueTable, facts: readonly MaterialFact[]): SignalEval {
  const saga = facts.filter((fact) => roundsIn(fact.text) >= 3).map((fact) => fact.id);
  return { holds: saga.length > 0, facts: saga };
}

function statusReport(cues: CueTable, facts: readonly MaterialFact[]): SignalEval {
  const items = ids([...cues.taskRef, ...cues.transition]);
  return { holds: items.length >= 5 && items.length * 2 >= facts.length, facts: items };
}

/**
 * One rule per signal in `vocabulary.yaml`'s `signals` list, each over the cue table only. The thresholds are a v0
 * reading of story-structure §4's questions; the audition's judge-scored fit (PP-8) is where judgement enters.
 */
export const SIGNAL_RULES: Record<string, SignalRule> = {
  "task-journey": { rule: "3+ facts with sequence cues and 1+ with a flow", evaluate: (c) => ({ holds: ids(c.sequence).length >= 3 && c.flow.length > 0, facts: ids([...c.sequence, ...c.flow]) }) },
  "decision-pending": { rule: "1+ fact with a decision cue, a verdict or a recommendation kind", evaluate: (c) => atLeast(1, c.decision) },
  "repo-overview": { rule: "facts cover 3+ of purpose, entry point, layout and read-first", evaluate: overview },
  anomaly: { rule: "1+ fact with an anomaly cue or a gotcha kind", evaluate: (c) => atLeast(1, c.anomaly) },
  "central-problem": { rule: "1 to 3 facts state a pain: one problem, not a list of complaints", evaluate: centralProblem },
  "parallel-findings": { rule: "3+ facts each name a check, finding, feature or risk, or share a group", evaluate: (c) => atLeast(3, c.parallel) },
  "attempts-failed": { rule: "1+ fact with an attempt cue and 1+ with a failure cue", evaluate: attemptsFailed },
  "many-review-rounds": { rule: "a fact names three or more review rounds", evaluate: rounds },
  "before-after": { rule: "2+ facts with a change cue", evaluate: (c) => atLeast(2, c.change) },
  experiment: { rule: "1+ fact with a method cue that also states a number", evaluate: experiment },
  cascade: { rule: "2+ facts with a cascade cue", evaluate: (c) => atLeast(2, c.cascade) },
  "board-moved": { rule: "3+ facts each name a task id and a status move", evaluate: (c) => atLeast(3, both(c.taskRef, c.transition)) },
  "status-report": { rule: "5+ facts name a task id or a status move, at least half of all facts", evaluate: statusReport },
};

/** Signals no deterministic rule can read; the map reports them as gaps and never calls a model for them. */
export const SIGNAL_GAPS: Record<string, string> = {
  "elegant-idea": "whether an idea is elegant is a judgement with no lexicon proxy; it needs the audition's judge (PP-8)",
};
