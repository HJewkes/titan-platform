import { defineCommand, type AnyCommand, type CliOption } from "@titan-design/registry";
import { LIST_PRICE_CAVEAT, type CostReportOptions } from "@titan-design/session-analytics";
import type { Db } from "@titan-design/store-sqlite";
import { z, type ZodType } from "zod";
import type { MinerContext } from "../context.js";

export const insightFilters = z.object({
  session: z.array(z.string().min(1)).optional().describe("only these session ids"),
  agentPrefix: z.string().min(1).optional().describe("only sessions whose agent-chat name starts with this"),
  role: z.array(z.string().min(1)).optional().describe("only these report roles, as byRole names them"),
  since: z.string().optional().describe("ISO timestamp or date, inclusive"),
  until: z.string().optional().describe("ISO timestamp or date, exclusive"),
});

export type InsightFilters = z.infer<typeof insightFilters>;

const FILTER_FLAGS: Record<keyof InsightFilters, CliOption> = {
  session: { long: "--session", description: "session id (repeatable)" },
  agentPrefix: { long: "--agent-prefix", description: "agent-chat name prefix" },
  role: { long: "--role", description: "report role (repeatable)" },
  since: { long: "--since", description: "ISO timestamp or date, inclusive" },
  until: { long: "--until", description: "ISO timestamp or date, exclusive" },
};

export interface InsightAnswer<Data> {
  data: Data;
  /** The text rendering; it ends with the list-price caveat. */
  text: string;
}

/** One question: its own options, the analytics call, its output schema and its text. */
export interface InsightQuestion<Options extends object = object, Data = unknown> {
  /** The plan's question id, such as Q1. */
  id: string;
  /** The CLI subcommand under `insights`; the MCP tool is `miner__insights__<name>`. */
  name: string;
  description: string;
  options: { [K in keyof Options]-?: ZodType<Options[K]> };
  flags: { [K in keyof Options]-?: CliOption };
  schema: ZodType<Data>;
  answer(db: Db, report: CostReportOptions, options: Options): InsightAnswer<Data>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyInsight = InsightQuestion<any, any>;

export function defineInsight<Options extends object, Data>(question: InsightQuestion<Options, Data>): InsightQuestion<Options, Data> {
  return question;
}

/** The JSON every question returns: the answer beside the caveat and the filters it ran with. */
export function insightResultSchema<Data>(schema: ZodType<Data>) {
  return z.object({ question: z.string(), caveat: z.literal(LIST_PRICE_CAVEAT), filters: insightFilters, answer: schema });
}

export function insightCommand(question: AnyInsight): AnyCommand<MinerContext> {
  const args = insightFilters.extend(question.options as z.ZodRawShape);
  return defineCommand({
    name: `insights.${question.name}`,
    description: `${question.id}: ${question.description}`,
    args,
    result: z.union([insightResultSchema(question.schema), z.string()]),
    cli: { options: { ...FILTER_FLAGS, ...(question.flags as Record<string, CliOption>) } },
    async run(parsed, ctx) {
      const { session, agentPrefix, role, since, until, ...options } = parsed as InsightFilters & Record<string, unknown>;
      const filters: InsightFilters = { session, agentPrefix, role, since, until };
      const { data, text } = question.answer(ctx.graph().db, reportOptions(filters), options);
      if (ctx.format === "human") return text;
      return { question: question.id, caveat: LIST_PRICE_CAVEAT, filters, answer: data };
    },
  });
}

function reportOptions(filters: InsightFilters): CostReportOptions {
  return { since: filters.since, until: filters.until, scope: { sessionIds: filters.session, agentPrefix: filters.agentPrefix, roles: filters.role } };
}
