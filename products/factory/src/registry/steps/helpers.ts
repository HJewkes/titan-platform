import type { StepKind } from "../../definition.js";
import { defineStep, type BaseEntry } from "../entry.js";

export const WRITE = "writes outside the run";
export const RECORD = "records a fact a replay must read back, never recompute";
/** A step whose body runs a repo-configured command: the same runner other steps write through, so no write is ruled out. */
export const RUNS = "runs a repo-configured command the factory cannot prove writes nothing";
export const READ = "read or wait whose result chose the branch taken; not yet reviewed for orphanSafe";

type Effect = BaseEntry["effect"];
type Target = "commit" | "pr" | "item" | "external";

export const READ_EFFECT: Effect = { class: "read" };

export const effect = (target: Target, reason: string): Effect => ({ class: "effect", target, reason });
export const irreversible = (target: Target, reason: string): Effect => ({ class: "irreversible", target, reason });
/** A read awaiting its S3/S4 review: it parks on restart exactly as before the registry, until it is classified. */
export const pending = (reason: string): Effect => ({ class: "pending", reason });

export const step = (name: string, op: StepKind, kind: BaseEntry["kind"], effectOf: Effect): BaseEntry =>
  defineStep({ name, op, kind, effect: effectOf, callSites: [name], version: { bump: 0 } });
