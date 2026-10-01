import { readFileSync } from "node:fs";
import {
  ACTION_CLASSES,
  cacheTtlReport,
  cacheTtlWhatIfSchema,
  costReport,
  costReportSchema,
  renderCacheTtlText,
  renderCostReportSections,
  type ActionClass,
} from "@titan-design/session-analytics";
import { z } from "zod";
import { defineInsight, type AnyInsight } from "./define.js";

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

/** Every insight question, in plan order; a new question is one definition added here. */
export const INSIGHT_QUESTIONS: readonly AnyInsight[] = [spendByAction, handoffThreshold, cacheTtl, wakeEconomics];
