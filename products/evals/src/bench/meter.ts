import { readFile } from "node:fs/promises";
import { priceRequest } from "@titan-design/session-analytics";

export interface MeterArm {
  id: string;
  model: string;
  effort: string;
}

export interface ModelTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

export interface MeterResult {
  tokens: Record<string, ModelTokens>;
  listUsd: number | null;
  effortSeen: string[];
  modelSeen: string[];
  sidechainLines: number;
  cliMismatch: boolean;
  outcome: "ok" | "arm-mismatch";
}

export interface MeterInput {
  transcriptPath: string;
  arm: MeterArm;
  cliResult?: unknown;
}

/** Above this relative gap the CLI's own cost and the transcript sum are flagged, not reconciled. */
const CLI_TOLERANCE = 0.01;

interface Request {
  model: string;
  tokens: ModelTokens;
  at: string;
}

type Json = Record<string, unknown>;

const asObject = (value: unknown): Json | undefined => (value && typeof value === "object" ? (value as Json) : undefined);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

function parseLines(text: string): Json[] {
  const lines: Json[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const line = asObject(JSON.parse(raw));
      if (line) lines.push(line);
    } catch {
      // A torn last line from a killed job must not void the whole transcript.
    }
  }
  return lines;
}

function requestOf(line: Json): { id: string | undefined; request: Request } | undefined {
  const message = asObject(line.message);
  const usage = asObject(message?.usage);
  if (!message || !usage || typeof message.model !== "string") return undefined;
  const creation = asObject(usage.cache_creation);
  const split = creation !== undefined;
  const total = num(usage.cache_creation_input_tokens);
  const tokens: ModelTokens = {
    input: num(usage.input_tokens),
    output: num(usage.output_tokens),
    cacheRead: num(usage.cache_read_input_tokens),
    cacheWrite5m: split ? num(creation.ephemeral_5m_input_tokens) : total,
    cacheWrite1h: split ? num(creation.ephemeral_1h_input_tokens) : 0,
  };
  const id = typeof message.id === "string" ? message.id : undefined;
  return { id, request: { model: message.model, tokens, at: String(line.timestamp ?? "") } };
}

/** The harness writes one line per content block of a response, each repeating the response's usage. */
function distinctRequests(lines: Json[]): Request[] {
  const seen = new Set<string>();
  const requests: Request[] = [];
  for (const line of lines) {
    const found = requestOf(line);
    if (!found) continue;
    if (found.id !== undefined) {
      if (seen.has(found.id)) continue;
      seen.add(found.id);
    }
    requests.push(found.request);
  }
  return requests;
}

function sumByModel(requests: Request[]): Record<string, ModelTokens> {
  const byModel: Record<string, ModelTokens> = {};
  for (const { model, tokens } of requests) {
    const sum = (byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 });
    for (const key of Object.keys(sum) as (keyof ModelTokens)[]) sum[key] += tokens[key];
  }
  return byModel;
}

function cliCostByModel(cliResult: unknown): Record<string, number> {
  const usage = asObject(asObject(cliResult)?.modelUsage) ?? {};
  const costs: Record<string, number> = {};
  for (const [model, entry] of Object.entries(usage)) {
    const cost = asObject(entry)?.costUSD;
    if (typeof cost === "number" && Number.isFinite(cost)) costs[model] = cost;
  }
  return costs;
}

/** A model's list cost: the price table per request, or the CLI's figure when any request has no row. Null when neither can say. */
function modelCost(requests: Request[], cliCost: number | undefined): number | null {
  const priced = requests.map(({ tokens, at, model }) =>
    priceRequest(
      { inputTokens: tokens.input, outputTokens: tokens.output, cacheReadTokens: tokens.cacheRead, cacheCreation5mTokens: tokens.cacheWrite5m, cacheCreation1hTokens: tokens.cacheWrite1h },
      model,
      at,
    ),
  );
  if (priced.every((price) => price.priced)) return priced.reduce((sum, price) => sum + price.costUsd, 0);
  return cliCost ?? null;
}

function listUsdOf(requests: Request[], cli: Record<string, number>): number | null {
  const models = [...new Set(requests.map((request) => request.model))];
  let total = 0;
  for (const model of models) {
    const cost = modelCost(requests.filter((request) => request.model === model), cli[model]);
    if (cost === null) return null;
    total += cost;
  }
  return total;
}

function cliDisagrees(listUsd: number | null, cli: Record<string, number>): boolean {
  const cliSum = Object.values(cli).reduce((sum, cost) => sum + cost, 0);
  if (listUsd === null || Object.keys(cli).length === 0) return false;
  return Math.abs(cliSum - listUsd) > CLI_TOLERANCE * Math.max(Math.abs(listUsd), Number.EPSILON);
}

function seenValues(lines: Json[]): { effortSeen: string[]; modelSeen: string[] } {
  const efforts = new Set<string>();
  const models = new Set<string>();
  for (const line of lines) {
    if (line.type !== "api-request") continue;
    const params = asObject(line.params);
    if (typeof params?.model === "string") models.add(params.model);
    const effort = asObject(params?.output_config)?.effort;
    if (typeof effort === "string") efforts.add(effort);
  }
  return { effortSeen: [...efforts], modelSeen: [...models] };
}

export async function meterJob(input: MeterInput): Promise<MeterResult> {
  const lines = parseLines(await readFile(input.transcriptPath, "utf8"));
  const requests = distinctRequests(lines);
  const cli = cliCostByModel(input.cliResult);
  const listUsd = listUsdOf(requests, cli);
  const { effortSeen, modelSeen } = seenValues(lines);
  const matches = effortSeen.every((effort) => effort === input.arm.effort) && modelSeen.every((model) => model === input.arm.model);
  return {
    tokens: sumByModel(requests),
    listUsd,
    effortSeen,
    modelSeen,
    sidechainLines: lines.filter((line) => line.isSidechain === true).length,
    cliMismatch: cliDisagrees(listUsd, cli),
    outcome: matches ? "ok" : "arm-mismatch",
  };
}
