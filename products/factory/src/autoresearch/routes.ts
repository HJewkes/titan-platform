import { arStepHandlers, arStepId, type ArPorts, type ArStepHandler } from "@titan-design/autoresearch";
import type { RoutedStepInput, StepRoute, StepUsage } from "@titan-design/workflow";
import { z } from "zod";
import { evidenceRecord } from "../evidence.js";
import { redactForEvidence } from "../redact.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Port error codes a later attempt can clear: a tree is live only until its agent exits. Every other code, a
 * frozen-file drift or a missing pin among them, needs a person, so a retry would only repeat it. A pin's `git fetch`
 * fails only while origin is unreachable, unlike a pin that is not on main.
 */
const RETRYABLE_CODES: readonly string[] = ["tree-live", "pin-fetch"];
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

const SyncMoved = z.object({ merged: z.object({ from: z.string(), to: z.string(), main: z.string() }), allowedFrozen: z.array(z.string()).optional() });

/** A sync that moved the ratchet is a ratchet move like any other, so its record is `autoresearch.ratchet` of kind `sync`. */
function syncMoveOf(step: RoutedStepInput, input: unknown, result: object) {
  const moved = SyncMoved.safeParse(result);
  if (!moved.success) return undefined;
  const { round, pr, pin, resolved } = z.record(z.string(), z.unknown()).parse(input);
  const { from, to, main } = moved.data.merged;
  return { move: { run: step.runId, round, from, to, kind: "sync", pr, main, resolved, allowedFrozen: moved.data.allowedFrozen, pin } };
}

/** The evidence kind and the move a step's record carries beside its result. */
function recordOf(name: string, step: RoutedStepInput, input: unknown, result: object): { kind: string; extra: object } {
  if (name === "ratchet") return { kind: name, extra: moveOf(step, input) };
  const synced = name === "sync" ? syncMoveOf(step, input, result) : undefined;
  return synced ? { kind: "ratchet", extra: synced } : { kind: name, extra: {} };
}

type HandlersFor = (runId: string) => { ports: ArPorts; byName: ReadonlyMap<string, ArStepHandler> };

/** Each route reads its input as JSON and answers under `result`, wrapped as factory evidence. */
function arRoute({ name, onRestart }: ArStepHandler, handlersFor: HandlersFor): StepRoute {
  const run = async (step: RoutedStepInput) => {
    try {
      const { ports, byName } = handlersFor(step.runId);
      const handler = byName.get(name)!;
      const input: unknown = JSON.parse(step.prompt);
      const result = await handler.run(input, step.signal, { firstStartedAt: step.firstStartedAt });
      const { kind, extra } = recordOf(handler.name, step, input, result);
      const body = { startedAt: step.firstStartedAt, restarts: step.restarts, result, ...extra };
      const output = JSON.stringify(evidenceRecord(`autoresearch.${kind}`, step, new Date(ports.now()).toISOString(), body));
      const usage = usageOf(result);
      return { ok: true as const, output, ...(usage ? { usage } : {}) };
    } catch (error) {
      const message = messageOf(error);
      return { ok: false as const, error: redactForEvidence(message), retryable: retryableOf(message) };
    }
  };
  return { match: arStepId(name), onRestart, runner: { run } };
}

const unbound = () => Promise.reject(new Error("[unbound] autoresearch ports are resolved per run"));
/** Handlers read their ports only when called, so the route list is built once from ports that are never reached. */
const UNBOUND: ArPorts = {
  pin: unbound, plan: unbound, allocTree: unbound, implement: unbound, staticCheck: unbound, micro: unbound, evalCase: unbound, ratchet: unbound, releaseTree: unbound, now: Date.now,
};

/**
 * Ports belong to a target, so each step resolves its run's own; a missing target throws inside the route and fails
 * the step. Handlers are built once per ports object.
 */
export function arRoutes(portsFor: (runId: string) => ArPorts): StepRoute[] {
  const built = new WeakMap<ArPorts, ReturnType<HandlersFor>>();
  const handlersFor: HandlersFor = (runId) => {
    const ports = portsFor(runId);
    const known = built.get(ports) ?? { ports, byName: new Map(arStepHandlers(ports).map((handler) => [handler.name, handler])) };
    built.set(ports, known);
    return known;
  };
  return arStepHandlers(UNBOUND).map((handler) => arRoute(handler, handlersFor));
}
