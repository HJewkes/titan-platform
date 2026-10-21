import type { RestartRule } from "@titan-design/workflow";
import { z } from "zod";
import type { Digest } from "./digest.js";
import type { ArDispatchStep } from "./manifest.js";
import type { ArPorts } from "./ports.js";
import { IdeaSchema } from "./schemas.js";

/** One dispatch step's port call; a host wraps it in a route and answers with its result under `result`. */
export interface ArStepHandler {
  name: ArDispatchStep;
  onRestart: RestartRule;
  /** Checks the step's JSON input against its schema, then calls the port. */
  run(input: unknown, signal: AbortSignal): Promise<object>;
}

function handler<I>(name: ArDispatchStep, onRestart: RestartRule, schema: z.ZodType<I>, fn: (input: I, signal: AbortSignal) => Promise<object>): ArStepHandler {
  return { name, onRestart, run: (input, signal) => fn(schema.parse(input), signal) };
}

const text = z.string();
const IdeaInput = z.object({ idea: IdeaSchema, tree: text, base: text });
const RunInput = z.object({ runId: text });
const Inputs = {
  pin: RunInput.extend({ pin: text }),
  eval: z.object({ tree: text, case: text, key: text }),
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
export function arStepHandlers(ports: ArPorts): ArStepHandler[] {
  return [
    handler("pin", "repeat", Inputs.pin, (input, signal) => ports.pin(input, signal)),
    handler("eval", "repeat", Inputs.eval, (input, signal) => ports.evalCase(input, signal)),
    handler("plan", "repeat", Inputs.plan, async (input, signal) => ({ ops: await ports.plan(input, signal) })),
    handler("alloc", "repeat", Inputs.alloc, (input, signal) => ports.allocTree(input, signal)),
    handler("implement", "repeat", Inputs.implement, (input, signal) => ports.implement(input, signal)),
    handler("l0", "repeat", Inputs.l0, (input, signal) => ports.staticCheck(input, signal)),
    handler("l1", "repeat", Inputs.l1, (input, signal) => ports.micro(input, signal)),
    handler("ratchet", "park", Inputs.ratchet, (input, signal) => ports.ratchet(input, signal)),
    handler("release", "repeat", Inputs.release, async (input, signal) => (await ports.releaseTree(input, signal), { released: input.tree })),
  ];
}
