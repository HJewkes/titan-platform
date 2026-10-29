import type { RestartRule } from "@titan-design/workflow";
import { z } from "zod";
import type { Digest } from "./digest.js";
import type { ArDispatchStep } from "./manifest.js";
import {
  CadenceRoundSchema,
  CadenceTriggerSchema,
  RATCHET_MOVED,
  RatchetKindSchema,
  RegistryRowSchema,
  SnapshotLogSchema,
  type ArPorts,
  type RoundRecord,
  type SnapshotRequest,
  type SyncRequest,
} from "./ports.js";
import { IdeaSchema } from "./schemas.js";

/** What the runtime knows about this try of the step, which never goes in the step's input, so a replay sees the same input. */
export interface StepTiming {
  /** When the step's first attempt started; a restart keeps it. */
  firstStartedAt?: string;
}

/** One dispatch step's port call; a host wraps it in a route and answers with its result under `result`. */
export interface ArStepHandler {
  name: ArDispatchStep;
  onRestart: RestartRule;
  /** Checks the step's JSON input against its schema, then calls the port. */
  run(input: unknown, signal: AbortSignal, timing?: StepTiming): Promise<object>;
}

type PortCall<I> = (input: I, signal: AbortSignal, timing: StepTiming) => Promise<object>;

function handler<I>(name: ArDispatchStep, onRestart: RestartRule, schema: z.ZodType<I>, fn: PortCall<I>): ArStepHandler {
  return { name, onRestart, run: (input, signal, timing = {}) => fn(schema.parse(input), signal, timing) };
}

const text = z.string();
const RunInput = z.object({ runId: text });
const RunPinInput = RunInput.extend({ pin: text, frozenHash: text.optional() });
const IdeaInput = RunPinInput.extend({ idea: IdeaSchema, tree: text, base: text });
const round = z.number().int().positive();
const count = z.number().int().nonnegative();
const QuotaInput = z.object({ keptLastRound: z.array(text), minPool: count, queuedBefore: count });
const Inputs = {
  pin: RunInput.extend({ pin: text }),
  eval: RunPinInput.extend({ tree: text, case: text, key: text, rung: text }),
  plan: RunInput.extend({ round, digest: z.custom<Digest>(), violations: z.array(text), quota: QuotaInput, mode: z.enum(["spawn", "resume"]) }),
  alloc: RunInput.extend({ ideaId: text, base: text, lane: z.number().int().positive() }),
  implement: RunInput.extend({ idea: IdeaSchema, tree: text, base: text, brief: text, round, lane: z.number().int().positive(), fork: z.enum(["exploit", "explore"]), resumeFrom: text.optional() }),
  l0: IdeaInput.extend({ head: text }),
  l1: IdeaInput.extend({ rung: text, case: text, baselineDir: text, microSignal: text, microArgs: z.record(text, text), key: text }),
  ratchet: RunPinInput.extend({
    tree: text, ratchetRef: text, ratchetPrefix: text, from: text, to: text,
    round, ideaId: text.optional(), kind: RatchetKindSchema, keepRung: text, delta: z.number(), sigma: z.number().nonnegative(), runDigests: z.array(text),
  }),
  integrate: RunInput.extend({ tree: text, base: text, head: text, message: text }),
  snapshot: RunPinInput.extend({
    k: z.number().int().positive(), trigger: CadenceTriggerSchema, round: CadenceRoundSchema, sha: text, ratchetRef: text, ratchetPrefix: text, log: SnapshotLogSchema,
  }),
  sync: RunPinInput.extend({
    round: CadenceRoundSchema, pr: z.number().int().positive(), branch: text, head: text, ratchetRef: text, ratchetPrefix: text, tree: text,
    resolved: text.optional(), allowedFrozen: z.array(text).optional(),
  }),
  release: z.object({ tree: text }),
  loadWait: z.object({ stage: text }),
  archive: RunInput.extend({ round, record: z.custom<RoundRecord>() }),
  inbox: RunInput.extend({ round, after: z.number().int().nonnegative() }),
  validate: RunPinInput.extend({ look: z.number().int().positive(), head: text }),
  registry: RunInput.extend({ row: RegistryRowSchema }),
};

/** A look with no validator cannot be answered by an empty aggregate, which a reader would take for a result. */
async function validateLook(ports: ArPorts, input: z.infer<typeof Inputs.validate>, signal: AbortSignal): Promise<object> {
  if (!ports.validate) throw new Error("[no-validator] this host has no validator port");
  return ports.validate(input, signal);
}

const at = (firstStartedAt: string | undefined) => (firstStartedAt === undefined ? {} : { at: firstStartedAt });

/**
 * A snapshot or sync that fails answers `failed` rather than throwing, so the failure is recorded and a replay never
 * repeats the port call where the first drive went on without it. A cancelled run and a moved ratchet still throw.
 */
async function failedAnswer(call: () => Promise<object>, signal: AbortSignal): Promise<object> {
  try {
    return await call();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (signal.aborted || message.startsWith(RATCHET_MOVED)) throw error;
    return { failed: message };
  }
}

async function cutSnapshot(ports: ArPorts, input: SnapshotRequest, signal: AbortSignal): Promise<object> {
  if (!ports.snapshot) return { failed: "[no-snapshot] this host has no snapshot port" };
  return failedAnswer(() => ports.snapshot!(input, signal), signal);
}

async function syncRatchet(ports: ArPorts, input: SyncRequest, signal: AbortSignal): Promise<object> {
  if (!ports.sync) return { failed: "[no-sync] this host has no sync port" };
  return failedAnswer(() => ports.sync!(input, signal), signal);
}

/**
 * Every step but the ratchet only reads, writes inside its own idea tree or rewrites its own round archive, so a restart repeats it;
 * a repeated registry row carries the same run and phase, so a host's reader keeps the last. An integrate re-checks-out its
 * base and merges with the step's first start as the date, so a repeat rebuilds the same commit; so does a snapshot's
 * log commit, and its tag, branch, PR and registration are each idempotent.
 * A ratchet push or a sync cut off mid-way may have moved the remote, so a person decides.
 */
export function arStepHandlers(ports: ArPorts): ArStepHandler[] {
  return [
    handler("pin", "repeat", Inputs.pin, (input, signal) => ports.pin(input, signal)),
    handler("eval", "repeat", Inputs.eval, (input, signal) => ports.evalCase(input, signal)),
    handler("plan", "repeat", Inputs.plan, (input, signal) => ports.plan(input, signal)),
    handler("alloc", "repeat", Inputs.alloc, (input, signal) => ports.allocTree(input, signal)),
    handler("implement", "repeat", Inputs.implement, (input, signal) => ports.implement(input, signal)),
    handler("l0", "repeat", Inputs.l0, (input, signal) => ports.staticCheck(input, signal)),
    handler("l1", "repeat", Inputs.l1, (input, signal) => ports.micro(input, signal)),
    handler("ratchet", "park", Inputs.ratchet, (input, signal) => ports.ratchet(input, signal)),
    handler("integrate", "repeat", Inputs.integrate, async (input, signal, { firstStartedAt }) =>
      ports.integrate ? ports.integrate({ ...input, ...at(firstStartedAt) }, signal) : { skipped: "no-integrate" },
    ),
    handler("snapshot", "repeat", Inputs.snapshot, (input, signal, { firstStartedAt }) => cutSnapshot(ports, { ...input, ...at(firstStartedAt) }, signal)),
    handler("sync", "park", Inputs.sync, (input, signal, { firstStartedAt }) => syncRatchet(ports, { ...input, ...at(firstStartedAt) }, signal)),
    handler("release", "repeat", Inputs.release, async (input, signal) => (await ports.releaseTree(input, signal), { released: input.tree })),
    handler("load-wait", "repeat", Inputs.loadWait, async (input, signal, { firstStartedAt }) =>
      ports.loadWait ? ports.loadWait({ ...input, ...(firstStartedAt === undefined ? {} : { firstStartedAt }) }, signal) : { waitedMs: 0 },
    ),
    handler("archive", "repeat", Inputs.archive, async (input, signal) => (ports.archive ? ports.archive(input, signal) : {})),
    handler("inbox", "repeat", Inputs.inbox, async (input, signal) => (ports.ownerIdeas ? ports.ownerIdeas(input, signal) : { ideas: [], cursor: input.after })),
    handler("validate", "repeat", Inputs.validate, (input, signal) => validateLook(ports, input, signal)),
    handler("registry", "repeat", Inputs.registry, async (input, signal) => (ports.registry ? ports.registry(input, signal) : {})),
  ];
}
