import { runL0, type L0Result } from "./eval-l0.js";
import { ScriptSchema, type ScriptBeat, type ScriptV1 } from "./script-schema.js";

// Synthetic: an invented parcel floor's day; nothing here quotes a real script, video, cost or repo.
type Cue = { action: "V6"; target: string; atCue: string };
type DailyBeat = [id: string, chapter: string, fn: string, plannedS: number, spoken: string, beat: string, labels: string[], cues?: Cue[]];

const cue = (target: string, atCue: string): Cue => ({ action: "V6", target, atCue });

const CHAPTERS = [
  ["bottom-line", "What did the floor decide today?"],
  ["goals", "What is each lane working toward?"],
  ["lanes", "What did each lane move?"],
  ["ships", "Which ships mattered most?"],
  ["side-quests", "What else got done on the side?"],
  ["stats", "What did the day cost?"],
  ["reflection", "What slows the floor down?"],
  ["ask", "What happens next?"],
].map(([id, question]) => ({ id, label: `${id} · ${question}`, question }));

export const SIDE_QUEST_LABELS = ["docs · Two pages renamed", "test · One flaky case retired", "ops · Night alarm muted"];

const BEATS: DailyBeat[] = [
  ["bottom-line-1", "bottom-line", "VERDICT", 14, "Ship it: the router lane holds, the matcher merged clean, and nothing was refused since noon.", "verdict-card",
    ["Ship it: the router lane holds", "Matcher rewrite merged clean", "No refusals since noon"], [cue("reasons-1", "clean"), cue("reasons-2", "noon")]],
  ["goals-1", "goals", "WHAT", 18, "The router lane wants faster matches, the cache lane wants a warm store, and the label lane wants fewer reprints.", "list",
    ["router · Faster matches", "cache · Warm store", "label · Fewer reprints"], [cue("rows-1", "matches"), cue("rows-2", "store"), cue("rows-3", "reprints")]],
  ["lanes-1", "lanes", "WHAT", 18, "The router lane rewrote its matcher and merged it before lunch, with the old path kept behind a switch.", "list",
    ["router · Matcher rewrite merged", "router · Old path behind a switch"], [cue("rows-1", "matcher"), cue("rows-2", "switch")]],
  ["lanes-2", "lanes", "WHAT", 18, "The cache lane warmed its store, cut cold reads, and left one eviction bug open for tomorrow.", "list",
    ["cache · Store warmed", "cache · Cold reads cut", "cache · Eviction bug open"], [cue("rows-1", "warmed"), cue("rows-3", "eviction")]],
  ["lanes-3", "lanes", "WHAT", 18, "The label lane merged three fixes, reviewed two more, and still holds one draft that waits on the router.", "list",
    ["label · Three fixes merged", "label · Two in review", "label · One draft waiting"], [cue("rows-1", "fixes"), cue("rows-3", "draft")]],
  ["lanes-4", "lanes", "WHAT", 18, "Across the week, merges climbed from four on Monday to nine today, the best day this month.", "chart",
    ["2026-01-05: 4", "2026-01-06: 6", "2026-01-07: 7", "2026-01-08: 9"], [cue("series-1", "monday"), cue("series-4", "today")]],
  ["ships-1", "ships", "WHAT", 18, "Before the rewrite, every scan waited on one queue; after it, each lane matches its own scans in parallel.", "compare",
    ["before: One shared queue", "after: One queue per lane"], [cue("rows-1", "queue"), cue("rows-2", "parallel")]],
  ["ships-2", "ships", "WHAT", 18, "The matcher now answers in twelve milliseconds where it took forty, and the slow tail is nearly gone.", "chart",
    ["old match: 40", "new match: 12", "slow tail: 3"], [cue("series-1", "twelve")]],
  ["side-quests-1", "side-quests", "WHAT", 12, "On the side, the docs lane renamed two pages, one flaky test retired, and the night alarm went quiet.", "list",
    SIDE_QUEST_LABELS, [cue("rows-1", "renamed"), cue("rows-2", "flaky")]],
  ["stats-1", "stats", "WHAT", 16, "Nine merges landed today, twelve lanes reported, and the review queue holds five pull requests.", "stat",
    ["9 merges", "12 lanes", "5 in review"], [cue("figures-1", "merges"), cue("figures-3", "review")]],
  ["reflection-1", "reflection", "WHAT", 16, "What slows the floor is the shared review queue and the drafts that wait on another lane to land first.", "list",
    ["slow · Shared review queue", "slow · Drafts waiting on lanes"], [cue("rows-1", "review"), cue("rows-2", "drafts")]],
  ["reflection-2", "reflection", "WHAT", 12, "Small lanes ship faster than one big queue, and today showed it again.", "claim-card",
    ["Small lanes ship faster than one big queue"]],
  ["ask-1", "ask", "CLOSE", 8, "Read the digest, then pick the next lane.", "button", ["Read the digest", "Open digest"]],
];

const scriptBeat = ([id, chapter, fn, plannedS, spoken, beat, labels, cues = []]: DailyBeat) => ({
  id,
  chapter,
  function: fn,
  mode: "explain",
  plannedS,
  spoken,
  fact_ids: [],
  visual: { assertion: `The floor reports ${chapter} for the day`, job: "numbers", beat, labels, cues },
});

/** A daily-overview script in the goal-walk blocks: 8 chapters, 13 beats, every lane list at most 5 rows. */
export function dailyScript(labels: Record<string, string[]> = {}): ScriptV1 {
  return ScriptSchema.parse({
    schema: "script/v1",
    id: "parcel-floor-day",
    profile: "daily-overview",
    facts_pack: "facts.tsv",
    video: {
      audience: { persona: "Floor lead", proximity: "runs the floor", gloss: "broad" },
      stake: "TODO: stake",
      promise: "You can tell what the floor moved today",
      thesis_mechanism: "each lane reports what it merged against its goal",
      running_example: "TODO: example",
      simplifications: [],
      close_type: "callback",
    },
    chapters: CHAPTERS,
    beats: BEATS.map(scriptBeat).map((beat) => (labels[beat.id] ? { ...beat, visual: { ...beat.visual, labels: labels[beat.id] } } : beat)),
  });
}

type Patch = Partial<Omit<ScriptBeat, "visual">> & { visual?: Partial<ScriptBeat["visual"]> };

/** The synthetic daily script with one beat's fields and visual fields replaced. */
export function dailyWith(id: string, patch: Patch, script: ScriptV1 = dailyScript()): ScriptV1 {
  const beats = script.beats.map((beat) => (beat.id === id ? { ...beat, ...patch, visual: { ...beat.visual, ...patch.visual } } : beat));
  return { ...script, beats };
}

/** One row of the shipped L0 set, as the script stage runs it. */
export const l0Row = (script: ScriptV1, checkId: string): L0Result => runL0(script).find((row) => row.check_id === checkId)!;
