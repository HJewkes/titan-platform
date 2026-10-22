import type { RestartRule } from "@titan-design/workflow";
import { z } from "zod";
import type { Digest } from "./digest.js";
import type { ArDispatchStep } from "./manifest.js";
import type { ArPorts, RoundRecord } from "./ports.js";
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
const round = z.number().int().positive();
const Inputs = {
  pin: RunInput.extend({ pin: text }),
  eval: z.object({ tree: text, case: text, key: text, rung: text }),
  plan: RunInput.extend({ round, digest: z.custom<Digest>(), violations: z.array(text), mode: z.enum(["spawn", "resume"]) }),
  alloc: RunInput.extend({ ideaId: text, base: text, lane: z.number().int().positive() }),
  implement: IdeaInput.extend({ brief: text, round, lane: z.number().int().positive(), fork: z.enum(["exploit", "explore"]), resumeFrom: text.optional() }),
  l0: IdeaInput.extend({ head: text }),
  l1: IdeaInput.extend({ rung: text, case: text, baselineDir: text, microSignal: text, microArgs: z.record(text, text), key: text }),
  ratchet: z.object({
    tree: text, ratchetRef: text, ratchetPrefix: text, from: text, to: text,
    round, ideaId: text, kind: z.literal("ff"), keepRung: text, delta: z.number(), sigma: z.number().nonnegative(), runDigests: z.array(text), pin: text,
  }),
  release: z.object({ tree: text }),
  loadWait: z.object({ stage: text }),
  archive: RunInput.extend({ round, record: z.custom<RoundRecord>() }),
};

/**
 * Every step but the ratchet only reads, writes inside its own idea tree or rewrites its own round archive, so a restart repeats it.
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
    handler("load-wait", "repeat", Inputs.loadWait, async (input, signal) => (ports.loadWait ? ports.loadWait(input, signal) : { waitedMs: 0 })),
    handler("archive", "repeat", Inputs.archive, async (input, signal) => (ports.archive ? ports.archive(input, signal) : {})),
  ];
}
