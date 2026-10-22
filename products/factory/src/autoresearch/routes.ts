import { arStepHandlers, arStepId, type ArPorts, type ArStepHandler } from "@titan-design/autoresearch";
import type { RoutedStepInput, StepRoute, StepUsage } from "@titan-design/workflow";
import { evidenceRecord } from "../evidence.js";
import { redactForEvidence } from "../redact.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

interface PortSpend {
  usd?: unknown;
  usage?: { usd: number; cacheReadTokens?: number; cacheWrite5mTokens?: number; cacheWrite1hTokens?: number };
}

/** A dispatch's own `usage` wins; an eval or micro run reports only the model dollars it spent as `usd`. */
function usageOf(result: object): StepUsage | undefined {
  const { usd, usage } = result as PortSpend;
  if (usage) {
    const { usd: costUsd, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens } = usage;
    const reported = Object.entries({ cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens }).filter(([, tokens]) => tokens !== undefined);
    return { costUsd, ...Object.fromEntries(reported) };
  }
  return typeof usd === "number" ? { costUsd: usd } : undefined;
}

/** G12: the ratchet's evidence names the move it made, not only the head it reached. */
function moveOf(step: RoutedStepInput, input: Record<string, unknown>) {
  const { round, ideaId, from, to, kind, keepRung, delta, sigma, runDigests, pin } = input;
  return { move: { run: step.runId, round, idea: ideaId, from, to, kind, keepRung, delta, sigma, runDigests, pin } };
}

/** Each route reads its input as JSON and answers under `result`, wrapped as factory evidence. */
function arRoute(handler: ArStepHandler, ports: ArPorts): StepRoute {
  const run = async (step: RoutedStepInput) => {
    try {
      const input = JSON.parse(step.prompt) as Record<string, unknown>;
      const result = await handler.run(input, step.signal);
      const body = { startedAt: step.firstStartedAt, restarts: step.restarts, result, ...(handler.name === "ratchet" ? moveOf(step, input) : {}) };
      const output = JSON.stringify(evidenceRecord(`autoresearch.${handler.name}`, step, new Date(ports.now()).toISOString(), body));
      const usage = usageOf(result);
      return { ok: true as const, output, ...(usage ? { usage } : {}) };
    } catch (error) {
      return { ok: false as const, error: redactForEvidence(messageOf(error)), retryable: false };
    }
  };
  return { match: arStepId(handler.name), onRestart: handler.onRestart, runner: { run } };
}

export function arRoutes(ports: ArPorts): StepRoute[] {
  return arStepHandlers(ports).map((handler) => arRoute(handler, ports));
}
