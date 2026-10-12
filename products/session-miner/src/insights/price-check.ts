import { readFileSync } from "node:fs";
import { EXIT } from "@titan-design/registry";
import { PRICE_TABLE, costReport, costReportSchema, findPrice, renderCostReportSections, type PriceRow } from "@titan-design/session-analytics";
import { z } from "zod";
import { defineInsight } from "./define.js";

const PRICE_FIELDS = ["input", "cacheRead", "cacheWrite5m", "cacheWrite1h", "output"] as const;
type PriceField = (typeof PRICE_FIELDS)[number];

const usdPerMillion = z.number().nonnegative();

const publishedPriceSchema = z.object({
  model: z.string().min(1),
  input: usdPerMillion,
  cacheRead: usdPerMillion,
  cacheWrite5m: usdPerMillion,
  cacheWrite1h: usdPerMillion,
  output: usdPerMillion,
});
type PublishedPrice = z.infer<typeof publishedPriceSchema>;

const ratesSchema = publishedPriceSchema.omit({ model: true });
const priceRowSchema = ratesSchema.extend({
  modelPrefix: z.string(),
  effectiveFrom: z.string(),
  longPrompt: ratesSchema.extend({ abovePromptTokens: z.number().int().positive() }).optional(),
});

const mismatchSchema = z.object({
  model: z.string(),
  reason: z.enum(["missing", "differs"]),
  /** The table row `findPrice` chose for the model, or null when none covers it. */
  tableRow: z.string().nullable(),
  fields: z.array(z.object({ field: z.enum(PRICE_FIELDS), published: z.number(), table: z.number() })),
});
type PriceMismatch = z.infer<typeof mismatchSchema>;

const reportSchema = costReportSchema.pick({ window: true, priceTableVersion: true, totals: true, coverage: true, unpricedModels: true });

export const priceCheckSchema = reportSchema.extend({
  rows: z.array(priceRowSchema),
  /** Null when no published file was given, so an unchecked table never reads as a clean one. */
  mismatches: z.array(mismatchSchema).nullable(),
});
export type PriceCheck = z.infer<typeof priceCheckSchema>;

/** A published file is the operator's data, so a malformed one is a usage error rather than a data error. */
function readPublished(file: string): PublishedPrice[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`cannot read published price file ${file}: ${error instanceof Error ? error.message : String(error)}`), { code: EXIT.USAGE });
  }
  const parsed = z.array(publishedPriceSchema).safeParse(raw);
  if (!parsed.success) throw Object.assign(new Error(`invalid published price file ${file}: ${z.prettifyError(parsed.error)}`), { code: EXIT.USAGE });
  return parsed.data;
}

/** Every published model the table prices differently, or not at all, as `findPrice` resolves it at `at`. */
export function comparePrices(published: readonly PublishedPrice[], at: string, table: readonly PriceRow[] = PRICE_TABLE): PriceMismatch[] {
  return published.flatMap((price): PriceMismatch[] => {
    const row = findPrice(price.model, at, table);
    if (row === null) return [{ model: price.model, reason: "missing", tableRow: null, fields: [] }];
    const fields = PRICE_FIELDS.filter((field) => row[field] !== price[field]).map((field: PriceField) => ({ field, published: price[field], table: row[field] }));
    return fields.length === 0 ? [] : [{ model: price.model, reason: "differs", tableRow: row.modelPrefix, fields }];
  });
}

function rowsText(rows: readonly PriceRow[]): string {
  const lines = rows.map((row) => `  ${row.modelPrefix} from ${row.effectiveFrom}: ${PRICE_FIELDS.map((field) => `${field} ${row[field]}`).join(", ")}`);
  return ["Price table (USD per million tokens)", ...lines].join("\n");
}

function unpricedText(unpriced: PriceCheck["unpricedModels"]): string {
  if (unpriced.length === 0) return "Unpriced models in the window: none";
  return ["Unpriced models in the window", ...unpriced.map((m) => `  ${m.model}: ${m.requests} requests, ${m.tokens} tokens`)].join("\n");
}

function mismatchText(mismatches: PriceCheck["mismatches"]): string {
  if (mismatches === null) return "Published prices: none given, so the table is unchecked (pass --published <file>).";
  if (mismatches.length === 0) return "Published prices: every model matches the table.";
  const lines = mismatches.map((m) =>
    m.reason === "missing"
      ? `  ${m.model}: missing, no table row prices it`
      : `  ${m.model}: differs from row ${m.tableRow}: ${m.fields.map((f) => `${f.field} published ${f.published}, table ${f.table}`).join("; ")}`,
  );
  return [`Published prices: ${mismatches.length} mismatched`, ...lines, "No cost claim until this is empty."].join("\n");
}

/** The cost report's header first and its caveat and footer last, as every other question renders. */
function renderPriceCheck(full: Parameters<typeof renderCostReportSections>[0], data: PriceCheck): string {
  const [header, ...tail] = renderCostReportSections(full, []).split("\n\n");
  return [header, rowsText(PRICE_TABLE), unpricedText(data.unpricedModels), mismatchText(data.mismatches), ...tail].join("\n\n");
}

export const priceCheck = defineInsight<{ published?: string }, PriceCheck>({
  id: "Q0",
  name: "prices",
  description: "The price table, the window's unpriced models, and every published price the table gets wrong",
  options: { published: z.string().min(1).optional().describe("JSON file of published prices: [{ model, input, cacheRead, cacheWrite5m, cacheWrite1h, output }]") },
  flags: { published: { long: "--published", description: "published price file" } },
  schema: priceCheckSchema,
  cliOnly: ["published"],
  answer(db, report, options) {
    const full = costReport(db, report);
    const at = report.until ?? new Date().toISOString();
    const mismatches = options.published === undefined ? null : comparePrices(readPublished(options.published), at);
    const data: PriceCheck = { ...reportSchema.parse(full), rows: [...PRICE_TABLE], mismatches };
    return { data, text: renderPriceCheck(full, data) };
  },
});
