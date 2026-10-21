import type { RestartRule, RoutedStepInput, StepRoute } from "@titan-design/workflow";
import { z } from "zod";
import { evidenceRecord } from "../evidence.js";
import { redactForEvidence } from "../redact.js";
import { arStepId, type ArDispatchStep } from "./manifest.js";
import type { ArPorts } from "./ports.js";
import { IdeaSchema } from "./schemas.js";
import type { Digest } from "./digest.js";

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Each route reads its input as JSON and answers under `result`, wrapped as factory evidence. */
function arRoute<I>(name: ArDispatchStep, ports: ArPorts, onRestart: RestartRule, schema: z.ZodType<I>, fn: (input: I, signal: AbortSignal) => Promise<object>): StepRoute {
  const match = arStepId(name);
  const run = async (step: RoutedStepInput) => {
    try {
      const result = await fn(schema.parse(JSON.parse(step.prompt)), step.signal);
      return { ok: true as const, output: JSON.stringify(evidenceRecord(`autoresearch.${name}`, step, new Date(ports.now()).toISOString(), { result })) };
    } catch (error) {
      return { ok: false as const, error: redactForEvidence(messageOf(error)), retryable: false };
    }
  };
  return { match, onRestart, runner: { run } };
}

const text = z.string();
const IdeaInput = z.object({ idea: IdeaSchema, tree: text, base: text });
const RunInput = z.object({ runId: text });
const Inputs = {
  pin: RunInput.extend({ pin: text }),
  eval: z.object({ tree: text, seed: text, key: text }),
  plan: RunInput.extend({ round: z.number(), digest: z.custom<Digest>(), violations: z.array(text) }),
  alloc: RunInput.extend({ ideaId: text, base: text }),
  implement: IdeaInput.extend({ brief: text }),
  l0: IdeaInput.extend({ head: text }),
  l1: IdeaInput.extend({ rung: text }),
  ratchet: z.object({ tree: text, ratchetRef: text, ratchetPrefix: text, from: text, to: text }),
  release: z.object({ tree: text }),
};

/**
 * Every step but the ratchet only reads, or writes inside its own idea tree, so a restart repeats it.
 * A ratchet push cut off mid-way may have moved the remote, so a person decides.
 */
export function arRoutes(ports: ArPorts): StepRoute[] {
  return [
    arRoute("pin", ports, "repeat", Inputs.pin, (input, signal) => ports.pin(input, signal)),
    arRoute("eval", ports, "repeat", Inputs.eval, (input, signal) => ports.evalSeed(input, signal)),
    arRoute("plan", ports, "repeat", Inputs.plan, async (input, signal) => ({ ops: await ports.plan(input, signal) })),
    arRoute("alloc", ports, "repeat", Inputs.alloc, (input, signal) => ports.allocTree(input, signal)),
    arRoute("implement", ports, "repeat", Inputs.implement, (input, signal) => ports.implement(input, signal)),
    arRoute("l0", ports, "repeat", Inputs.l0, (input, signal) => ports.staticCheck(input, signal)),
    arRoute("l1", ports, "repeat", Inputs.l1, (input, signal) => ports.micro(input, signal)),
    arRoute("ratchet", ports, "park", Inputs.ratchet, (input, signal) => ports.ratchet(input, signal)),
    arRoute("release", ports, "repeat", Inputs.release, async (input, signal) => (await ports.releaseTree(input, signal), { released: input.tree })),
  ];
}
