import { arStepHandlers, arStepId, type ArPorts, type ArStepHandler } from "@titan-design/autoresearch";
import type { RoutedStepInput, StepRoute, StepUsage } from "@titan-design/workflow";
import { z } from "zod";
import { evidenceRecord } from "../evidence.js";
import { redactForEvidence } from "../redact.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Port error codes a later attempt can clear: a tree is live only until its agent exits. Every other code, a
 * frozen-file drift or a missing pin among them, needs a person, so a retry would only repeat it.
 */
const RETRYABLE_CODES: readonly string[] = ["tree-live"];
const retryableOf = (message: string): boolean => RETRYABLE_CODES.some((code) => message.startsWith(`[${code}] `));

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
function moveOf(step: RoutedStepInput, input: unknown) {
  const { round, ideaId, from, to, kind, keepRung, delta, sigma, runDigests, pin } = z.record(z.string(), z.unknown()).parse(input);
  return { move: { run: step.runId, round, idea: ideaId, from, to, kind, keepRung, delta, sigma, runDigests, pin } };
}

/** Each route reads its input as JSON and answers under `result`, wrapped as factory evidence. */
function arRoute(handler: ArStepHandler, ports: ArPorts): StepRoute {
  const run = async (step: RoutedStepInput) => {
    try {
      const input: unknown = JSON.parse(step.prompt);
      const result = await handler.run(input, step.signal, { firstStartedAt: step.firstStartedAt });
      const body = { startedAt: step.firstStartedAt, restarts: step.restarts, result, ...(handler.name === "ratchet" ? moveOf(step, input) : {}) };
      const output = JSON.stringify(evidenceRecord(`autoresearch.${handler.name}`, step, new Date(ports.now()).toISOString(), body));
      const usage = usageOf(result);
      return { ok: true as const, output, ...(usage ? { usage } : {}) };
    } catch (error) {
      const message = messageOf(error);
      return { ok: false as const, error: redactForEvidence(message), retryable: retryableOf(message) };
    }
  };
  return { match: arStepId(handler.name), onRestart: handler.onRestart, runner: { run } };
}

export function arRoutes(ports: ArPorts): StepRoute[] {
  return arStepHandlers(ports).map((handler) => arRoute(handler, ports));
}
