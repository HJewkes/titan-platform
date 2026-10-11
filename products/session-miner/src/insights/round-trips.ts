import { LIST_PRICE_CAVEAT } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z } from "zod";
import { withEventsDb } from "./blocked-flow-sources.js";
import { defineInsight, localDay, refuseSessionScope } from "./define.js";

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

const FOLLOW_UP_CLASSES = [...FOLLOW_UP_PATTERNS.map(([name]) => name), "other"] as const;
type FollowUpClass = (typeof FOLLOW_UP_CLASSES)[number];

/** Only the opening of a message is classed, as the self-improve classifier did, so a long quoted brief cannot match. */
const CLASSED_CHARS = 1500;

function classifyFollowUp(body: string): FollowUpClass {
  const head = body.slice(0, CLASSED_CHARS);
  return FOLLOW_UP_PATTERNS.find(([, pattern]) => pattern.test(head))?.[0] ?? "other";
}

const VERDICT_WORD = /Verdict:\s*([A-Z_]{4,})/;
const PR_LINE = /PR:\s*(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)/;

const messageRows = z.array(z.object({ ts: z.number(), actor: z.string(), target: z.string().nullable(), body: z.string() }));
type EventMessage = z.infer<typeof messageRows>[number];
const spawnRows = z.array(z.object({ child: z.string(), parent: z.string() }));

const MESSAGES_SQL = "SELECT ts, actor, target, coalesce(body, '') AS body FROM events WHERE kind = 'message' AND ts >= @since AND ts < @until ORDER BY id";
const SPAWNERS_SQL = "SELECT target AS child, actor AS parent FROM events WHERE kind = 'agent_spawned' AND target IS NOT NULL AND ts < @until ORDER BY id";

/** Messages in the window, and each agent's spawner from every spawn before `until`, so a child spawned before the window still counts. */
function readRoundTripEvents(db: Db, window: { since?: string; until?: string }): { messages: EventMessage[]; spawners: Map<string, string> } {
  const bounds = { since: window.since ? Date.parse(window.since) : 0, until: window.until ? Date.parse(window.until) : Number.MAX_SAFE_INTEGER };
  const messages = messageRows.parse(db.prepare(MESSAGES_SQL).all(bounds));
  const spawns = spawnRows.parse(db.prepare(SPAWNERS_SQL).all({ until: bounds.until }));
  return { messages, spawners: new Map(spawns.map((s) => [s.child, s.parent])) };
}

export const roundTripsSchema = z.object({
  window: z.object({ since: z.string().nullable(), until: z.string().nullable() }),
  totals: z.object({
    messages: z.number().int(),
    followUps: z.number().int(),
    verdicts: z.number().int(),
    verdictsWithoutPrLine: z.number().int(),
    prs: z.number().int(),
    firstPassMerges: z.number().int(),
  }),
  followUps: z.array(z.object({ day: z.string(), class: z.enum(FOLLOW_UP_CLASSES), count: z.number().int() })),
  verdictDays: z.array(z.object({ day: z.string(), verdicts: z.number().int(), withoutPrLine: z.number().int(), firstVerdicts: z.number().int(), firstPassMerges: z.number().int() })),
  prs: z.array(z.object({ pr: z.string(), verdicts: z.array(z.string()), fixFirstRounds: z.number().int(), reReviews: z.number().int(), firstPassMerge: z.boolean(), firstDay: z.string() })),
});

export type RoundTripsReport = z.infer<typeof roundTripsSchema>;
type VerdictDay = RoundTripsReport["verdictDays"][number];
type PrRow = RoundTripsReport["prs"][number];

function followUpRows(messages: readonly EventMessage[], spawners: ReadonlyMap<string, string>): RoundTripsReport["followUps"] {
  const rows = new Map<string, { day: string; class: FollowUpClass; count: number }>();
  for (const m of messages) {
    if (m.target === null || spawners.get(m.target) !== m.actor) continue;
    const row = { day: localDay(m.ts), class: classifyFollowUp(m.body), count: 0 };
    const key = `${row.day}\u0000${row.class}`;
    if (!rows.has(key)) rows.set(key, row);
    rows.get(key)!.count += 1;
  }
  return [...rows.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}

/** Each PR's verdicts in order; a verdict whose PR line is missing or unreadable counts toward its day and no PR. */
function verdictRows(messages: readonly EventMessage[]): { prs: PrRow[]; days: VerdictDay[] } {
  const sequences = new Map<string, { day: string; verdict: string }[]>();
  const days = new Map<string, VerdictDay>();
  const dayRow = (day: string): VerdictDay => {
    if (!days.has(day)) days.set(day, { day, verdicts: 0, withoutPrLine: 0, firstVerdicts: 0, firstPassMerges: 0 });
    return days.get(day)!;
  };
  for (const m of messages) {
    const verdict = VERDICT_WORD.exec(m.body)?.[1];
    if (!verdict) continue;
    const day = localDay(m.ts);
    dayRow(day).verdicts += 1;
    const pr = PR_LINE.exec(m.body);
    if (!pr) {
      dayRow(day).withoutPrLine += 1;
      continue;
    }
    const key = `${pr[1]}#${pr[2]}`;
    sequences.set(key, [...(sequences.get(key) ?? []), { day, verdict }]);
  }
  const prs = [...sequences.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([pr, seq]): PrRow => {
    const verdicts = seq.map((s) => s.verdict);
    return { pr, verdicts, fixFirstRounds: verdicts.filter((v) => v !== "MERGE").length, reReviews: verdicts.length - 1, firstPassMerge: verdicts[0] === "MERGE", firstDay: seq[0]!.day };
  });
  for (const pr of prs) {
    dayRow(pr.firstDay).firstVerdicts += 1;
    if (pr.firstPassMerge) dayRow(pr.firstDay).firstPassMerges += 1;
  }
  return { prs, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}

function roundTripsReport(events: { messages: readonly EventMessage[]; spawners: ReadonlyMap<string, string> }, window: { since?: string; until?: string }): RoundTripsReport {
  const followUps = followUpRows(events.messages, events.spawners);
  const { prs, days } = verdictRows(events.messages);
  const sum = (key: keyof Omit<VerdictDay, "day">) => days.reduce((n, d) => n + d[key], 0);
  return {
    window: { since: window.since ?? null, until: window.until ?? null },
    totals: {
      messages: events.messages.length,
      followUps: followUps.reduce((n, r) => n + r.count, 0),
      verdicts: sum("verdicts"),
      verdictsWithoutPrLine: sum("withoutPrLine"),
      prs: prs.length,
      firstPassMerges: sum("firstPassMerges"),
    },
    followUps,
    verdictDays: days,
    prs,
  };
}

const cell = (value: string | number) => String(value).replaceAll("|", "\\|");
const table = (header: string[], rows: (string | number)[][]) =>
  [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

function renderRoundTripsText(data: RoundTripsReport): string {
  const { totals, window } = data;
  const header = [
    `Round trips per local day, ${window.since ?? "beginning"} to ${window.until ?? "now"}`,
    `${totals.followUps} parent-to-child follow-ups among ${totals.messages} messages; ${totals.verdicts} verdicts on ${totals.prs} PRs ` +
      `(${totals.firstPassMerges} merged on the first verdict, ${totals.verdictsWithoutPrLine} verdicts with no PR line).`,
  ].join("\n");
  const followUps = table(["day", "class", "count"], data.followUps.map((r) => [r.day, r.class, r.count]));
  const days = table(["day", "verdicts", "without PR line", "first verdicts", "first-pass merges"], data.verdictDays.map((r) => [r.day, r.verdicts, r.withoutPrLine, r.firstVerdicts, r.firstPassMerges]));
  const prs = table(["PR", "verdicts", "FIX_FIRST rounds", "re-reviews"], data.prs.map((r) => [r.pr, r.verdicts.join(" "), r.fixFirstRounds, r.reReviews]));
  return [header, followUps, days, prs, LIST_PRICE_CAVEAT].join("\n\n") + "\n";
}

/** Q6's answer for a window, shared with the probes question. */
export function answerRoundTrips(eventsDb: string, window: { since?: string; until?: string }): RoundTripsReport {
  return roundTripsReport(withEventsDb(eventsDb, (db) => readRoundTripEvents(db, window)), window);
}

export const roundTrips = defineInsight<Record<never, never>, RoundTripsReport>({
  id: "Q6",
  name: "round-trips",
  description: "Parent-to-child follow-ups by class and per-PR verdict rounds per local day, from agent-chat's events",
  options: {},
  flags: {},
  schema: roundTripsSchema,
  answer(_db, report, _options, config) {
    refuseSessionScope("round-trips", report.scope, "");
    const data = answerRoundTrips(config.eventsDb, report);
    return { data, text: renderRoundTripsText(data) };
  },
});
