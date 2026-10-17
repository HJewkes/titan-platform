import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createCodexExecAdapter, checkCodexAvailable, runAgent, type AgentRunResult, type HarnessAdapter, type HarnessRunResult } from "@titan-design/agent";
import { foldUsage } from "@titan-design/agent-protocol";
import { toJSONSchema, z, type ZodType } from "zod";

export const JUDGE_PROVIDERS = ["claude-print", "codex"] as const;

/**
 * Which model judges, and through which runtime. It comes from a config file, never a constant,
 * so a held-out judge is a config swap; its identity is part of every eval_version.
 */
export const JudgeConfigSchema = z
  .object({
    provider: z.enum(JUDGE_PROVIDERS),
    model: z.string().min(1),
    reasoning_effort: z.string().min(1).optional(),
    max_budget_usd: z.number().positive().default(0.5),
    wall_time_s: z.number().positive().default(600),
    /** Where this host keeps the codex binary; a host detail, so it is not part of the judge's identity. */
    executable_path: z.string().min(1).optional(),
  })
  .strict();

export type JudgeConfig = z.infer<typeof JudgeConfigSchema>;

/** The parts of a config that can change a verdict; budget, deadline and binary path only run it. */
export const judgeIdentity = ({ provider, model, reasoning_effort }: JudgeConfig) => ({ provider, model, ...(reasoning_effort ? { reasoning_effort } : {}) });

export const judgeLabel = (config: JudgeConfig): string =>
  `${config.provider}:${config.model}${config.reasoning_effort ? `@${config.reasoning_effort}` : ""}`;

export interface JudgeCall<T> {
  prompt: string;
  schema: ZodType<T>;
}

export type JudgeReply<T> =
  | { ok: true; output: T; usd: number; tokensIn: number; tokensOut: number }
  | { ok: false; reason: string; usd: number; tokensIn: number; tokensOut: number };

/** One fresh, tool-less model call that returns schema-valid JSON. Tests pass a fake. */
export type JudgeHarness = <T>(call: JudgeCall<T>) => Promise<JudgeReply<T>>;

export interface JudgeHarnessDeps {
  runAgent?: typeof runAgent;
  codexAdapter?: () => HarnessAdapter<"codex">;
  cwd?: string;
}

function claudePrintReply<T>(result: AgentRunResult<T>): JudgeReply<T> {
  const models = Object.values(result.usage?.modelUsage ?? {});
  const spend = {
    usd: result.usage?.totalCostUsd ?? 0,
    tokensIn: models.reduce((sum, m) => sum + m.inputTokens, 0),
    tokensOut: models.reduce((sum, m) => sum + m.outputTokens, 0),
  };
  return result.ok ? { ok: true, output: result.output, ...spend } : { ok: false, reason: `${result.failure.kind}: ${result.failure.reason}`, ...spend };
}

function codexSpend(result: HarnessRunResult<unknown, "codex">) {
  const measurements = foldUsage(result.usage).measurements;
  return {
    usd: measurements.reduce((sum, m) => sum + (m.cost?.usd ?? 0), 0),
    tokensIn: measurements.reduce((sum, m) => sum + (m.tokens.input ?? 0), 0),
    tokensOut: measurements.reduce((sum, m) => sum + (m.tokens.output ?? 0), 0),
  };
}

function codexOutput<T>(result: Extract<HarnessRunResult<T, "codex">, { ok: true }>, schema: ZodType<T>): T {
  return result.output.kind === "structured" ? result.output.value : schema.parse(JSON.parse(result.output.text));
}

/** Codex rejects zod's draft 2020-12 header the same way the claude CLI does. */
function codexSchema<T>(schema: ZodType<T>) {
  const jsonSchema = { ...toJSONSchema(schema) } as Record<string, unknown>;
  delete jsonSchema.$schema;
  return { jsonSchema, parse: (value: unknown) => schema.parse(value) };
}

function codexHarness(config: JudgeConfig, adapter: HarnessAdapter<"codex">, cwd: string): JudgeHarness {
  return async <T>({ prompt, schema }: JudgeCall<T>): Promise<JudgeReply<T>> => {
    const result = await adapter.run<T>({
      harness: "codex",
      prompt,
      cwd,
      target: { kind: "fresh", namespace: "explainer-eval" },
      wallTimeMs: config.wall_time_s * 1000,
      native: { model: config.model, sandbox: "read-only", outputSchema: codexSchema(schema), ...(config.reasoning_effort ? { reasoningEffort: config.reasoning_effort } : {}) },
    });
    const spend = codexSpend(result);
    if (!result.ok) return { ok: false, reason: `${result.failure.kind}: ${result.failure.reason}`, ...spend };
    try {
      return { ok: true, output: codexOutput(result, schema), ...spend };
    } catch (error) {
      return { ok: false, reason: `schema_invalid: ${error instanceof Error ? error.message : String(error)}`, ...spend };
    }
  };
}

/** Builds the harness the config names. Codex bills nothing per call here, so its budget is a deadline only. */
export function createJudgeHarness(config: JudgeConfig, deps: JudgeHarnessDeps = {}): JudgeHarness {
  const cwd = deps.cwd ?? process.cwd();
  if (config.provider === "codex") {
    const adapter = deps.codexAdapter?.() ?? createCodexExecAdapter({ auth: "cached-cli", ...(config.executable_path ? { executablePath: config.executable_path } : {}) });
    return codexHarness(config, adapter, cwd);
  }
  const run = deps.runAgent ?? runAgent;
  return async <T>({ prompt, schema }: JudgeCall<T>) =>
    claudePrintReply(
      await run<T>({
        harness: "claude-print",
        prompt,
        cwd,
        model: config.model,
        outputSchema: schema,
        maxTurns: 1,
        maxBudgetUsd: config.max_budget_usd,
        inactivityTimeoutMs: config.wall_time_s * 1000,
      }),
    );
}

/**
 * Why a codex judge cannot run on this host, or null. Codex keeps its ChatGPT login in
 * `$CODEX_HOME/auth.json`; the existing login-file presence hint remains separate
 * from the shared version/capability probe. This is async and starts no model.
 */
export async function codexUnavailable(config: Pick<JudgeConfig, "executable_path">, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const available = await checkCodexAvailable({ executablePath: config.executable_path, env, requiredCapabilities: ["output_schema"] });
  if (!available.ok) return available.failure.reason;
  const auth = join(env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  return existsSync(auth) ? null : `codex is not logged in on this host (no ${auth}); run \`codex login\` with the judge's account, then rerun`;
}
