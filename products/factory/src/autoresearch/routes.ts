import { arStepHandlers, arStepId, type ArPorts, type ArStepHandler } from "@titan-design/autoresearch";
import type { RoutedStepInput, StepRoute } from "@titan-design/workflow";
import { evidenceRecord } from "../evidence.js";
import { redactForEvidence } from "../redact.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Each route reads its input as JSON and answers under `result`, wrapped as factory evidence. */
function arRoute(handler: ArStepHandler, ports: ArPorts): StepRoute {
  const run = async (step: RoutedStepInput) => {
    try {
      const result = await handler.run(JSON.parse(step.prompt), step.signal);
      return { ok: true as const, output: JSON.stringify(evidenceRecord(`autoresearch.${handler.name}`, step, new Date(ports.now()).toISOString(), { result })) };
    } catch (error) {
      return { ok: false as const, error: redactForEvidence(messageOf(error)), retryable: false };
    }
  };
  return { match: arStepId(handler.name), onRestart: handler.onRestart, runner: { run } };
}

export function arRoutes(ports: ArPorts): StepRoute[] {
  return arStepHandlers(ports).map((handler) => arRoute(handler, ports));
}
