import { readFileSync } from "node:fs";
import { EXIT } from "@titan-design/registry";
import {
  ACTION_CLASSES,
  blockedFlowReport,
  blockedFlowSchema,
  cacheTtlReport,
  cacheTtlWhatIfSchema,
  costReport,
  costReportSchema,
  renderCacheTtlText,
  renderBlockedFlowText,
  renderCostReportSections,
  type ActionClass,
  type BlockedFlowReport,
  type ReportScope,
} from "@titan-design/session-analytics";
import { z } from "zod";
import { fetchPulls, readDenials, readJournal, readPullSnapshot, readVerdicts } from "./blocked-flow-sources.js";
import { defineInsight, isoTime, type AnyInsight } from "./define.js";

const reportFrame = { window: true, priceTableVersion: true, totals: true, coverage: true } as const;

const actionSchema = costReportSchema.pick({ ...reportFrame, byRole: true, byAction: true, mechanicalShare: true });

export const spendByAction = defineInsight<{ mechanical?: ActionClass[] }, z.infer<typeof actionSchema>>({
  id: "Q1",
  name: "spend-by-action",
  description: "Where each role's spend goes by turn action, and how much of it is mechanical",
  options: { mechanical: z.array(z.enum(ACTION_CLASSES)).optional().describe("action classes counted as mechanical") },
  flags: { mechanical: { long: "--mechanical", description: "action class counted as mechanical (repeatable)" } },
  schema: actionSchema,
  answer(db, report, options) {
    const full = costReport(db, { ...report, mechanicalClasses: options.mechanical });
    return { data: actionSchema.parse(full), text: renderCostReportSections(full, ["byRole", "byAction", "mechanicalShare"]) };
  },
});

const handoffSchema = costReportSchema.pick({ ...reportFrame, handoffThreshold: true });

interface HandoffInsightOptions {
  k?: number[];
  reviewerPrs?: number;
  brokerLog?: string;
}

export const handoffThreshold = defineInsight<HandoffInsightOptions, z.infer<typeof handoffSchema>>({
  id: "Q2",
  name: "handoff-threshold",
  description: "When each role should hand over: boot cost, fill growth and the best context threshold K",
  options: {
    k: z.array(z.number().int().positive()).optional().describe("configured thresholds to price against the best K"),
    reviewerPrs: z.number().int().positive().optional().describe("PRs a standing reviewer is compared over"),
    brokerLog: z.string().min(1).optional().describe("agent-chat broker log whose teleports give exit fill"),
  },
  flags: {
    k: { long: "--k", description: "configured K in tokens (repeatable)" },
    reviewerPrs: { long: "--reviewer-prs", description: "PRs per reviewer comparison" },
    brokerLog: { long: "--broker-log", description: "broker log path" },
  },
  schema: handoffSchema,
  cliOnly: ["brokerLog"],
  answer(db, report, options) {
    const brokerLog = options.brokerLog;
    const brokerLogLines = brokerLog === undefined ? undefined : () => readFileSync(brokerLog, "utf8").split("\n");
    const full = costReport(db, { ...report, brokerLogLines, handoff: { configuredK: options.k, reviewerPrs: options.reviewerPrs } });
    return { data: handoffSchema.parse(full), text: renderCostReportSections(full, ["handoff", "teleports", "reviewers"]) };
  },
});

export const cacheTtl = defineInsight<Record<never, never>, z.infer<typeof cacheTtlWhatIfSchema>>({
  id: "Q3",
  name: "cache-ttl",
  description: "What a 5-minute cache TTL would save against 1h, per role and profile",
  options: {},
  flags: {},
  schema: cacheTtlWhatIfSchema,
  answer(db, report) {
    const whatIf = cacheTtlReport(db, report);
    return { data: whatIf, text: renderCacheTtlText(whatIf) };
  },
});

const wakeSchema = costReportSchema.pick({ ...reportFrame, byWakeCause: true, wakeEpisodes: true });

export const wakeEconomics = defineInsight<{ episodeRole?: string[] }, z.infer<typeof wakeSchema>>({
  id: "Q4",
  name: "wake-economics",
  description: "What wakes a coordinator, and the requests and cost of each wake episode",
  options: { episodeRole: z.array(z.string().min(1)).optional().describe("roles whose wakes are cut into episodes") },
  flags: { episodeRole: { long: "--episode-role", description: "role cut into wake episodes (repeatable)" } },
  schema: wakeSchema,
  answer(db, report, options) {
    const full = costReport(db, { ...report, episodeRoles: options.episodeRole });
    return { data: wakeSchema.parse(full), text: renderCostReportSections(full, ["byWakeCause", "wakeEpisodes", "wakePairs"]) };
  },
});

interface BlockedFlowOptions {
  seat?: string[];
  splitAt?: string;
  transcript?: string[];
  journal?: string[];
  pulls?: string;
}

const seatPathSpec = z.string().regex(/^[^=]+=.+$/, "expected <seat>=<path>");

export const blockedFlow = defineInsight<BlockedFlowOptions, BlockedFlowReport>({
  id: "Q7",
  name: "blocked-flow",
  description: "Per repo: verdict-to-merge minutes, open PRs holding MERGE, classifier denials and idle implementer slots",
  options: {
    seat: z.array(z.string().min(1)).optional().describe("only verdicts sent to, and denials and journals of, these seats"),
    splitAt: isoTime.optional().describe("also split verdict-to-merge by verdict time at this ISO timestamp"),
    transcript: z.array(seatPathSpec).optional().describe("<seat>=<transcript .jsonl or directory> to read classifier denials from"),
    journal: z.array(seatPathSpec).optional().describe("<seat>=<journal YYYY-MM-DD.md> to read implementer slot ticks from"),
    pulls: z.string().min(1).optional().describe("JSON file of PR states to use instead of GitHub"),
  },
  flags: {
    seat: { long: "--seat", description: "seat name (repeatable)" },
    splitAt: { long: "--split-at", description: "ISO timestamp to split verdict-to-merge at" },
    transcript: { long: "--transcript", description: "<seat>=<path> seat transcript file or directory (repeatable)" },
    journal: { long: "--journal", description: "<seat>=<path> seat journal (repeatable)" },
    pulls: { long: "--pulls", description: "PR state snapshot file" },
  },
  schema: blockedFlowSchema,
  cliOnly: ["transcript", "journal", "pulls"],
  async answer(_db, report, options, config) {
    refuseSessionScope(report.scope);
    const window = { since: report.since, until: report.until };
    const verdicts = readVerdicts(config.eventsDb, window);
    const merges = verdicts.filter((v) => v.verdict === "MERGE");
    const pulls = options.pulls ? readPullSnapshot(options.pulls) : await fetchPulls(merges);
    const denials = (options.transcript ?? []).flatMap(readDenials);
    const journals = (options.journal ?? []).map(readJournal);
    const asOf = report.until ?? new Date().toISOString();
    const data = blockedFlowReport({ verdicts, pulls, denials, journals, asOf, window, splitAt: options.splitAt && new Date(options.splitAt).toISOString(), seats: options.seat });
    return { data, text: renderBlockedFlowText(data) };
  },
});

/** Blocked flow reads agent-chat, GitHub and seat files, not the session graph, so session filters would silently match nothing. */
function refuseSessionScope(scope: ReportScope | undefined): void {
  const given = Object.entries(scope ?? {}).filter(([, value]) => value !== undefined).map(([key]) => key);
  if (given.length > 0) throw Object.assign(new Error(`blocked-flow does not take ${given.join(", ")}; narrow it with --seat`), { code: EXIT.DATAERR });
}

/** Every insight question, in plan order; a new question is one definition added here. */
export const INSIGHT_QUESTIONS: readonly AnyInsight[] = [spendByAction, handoffThreshold, cacheTtl, wakeEconomics, blockedFlow];
