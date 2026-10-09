import { performance } from "node:perf_hooks";
import type { HealthSampleInput } from "@titan-design/health";

export const SELF_TARGET = "titan-health-sampler";

export interface SelfCostDeps {
  now: () => number;
  /** Milliseconds since the process started. */
  wallMs: () => number;
  cpuUsage: () => { user: number; system: number };
  resourceUsage: () => {
    fsRead: number;
    fsWrite: number;
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
    maxRSS: number;
  };
}

const processCost: SelfCostDeps = {
  now: Date.now,
  wallMs: () => performance.now(),
  cpuUsage: () => process.cpuUsage(),
  resourceUsage: () => process.resourceUsage(),
};

/**
 * The sampler's own cost as a `self` row. Every counter runs from process start, so node's own
 * startup is charged to the tick: a oneshot pays it every minute, and that is the real cost.
 */
export function measureSelf(targets: number, deps: SelfCostDeps = processCost): HealthSampleInput {
  const cpu = deps.cpuUsage();
  const usage = deps.resourceUsage();
  return {
    ts: new Date(deps.now()).toISOString(),
    target: SELF_TARGET,
    kind: "self",
    status: "pass",
    source: "probe",
    observed: {
      cpuUserUs: cpu.user,
      cpuSystemUs: cpu.system,
      fsReadBlocks: usage.fsRead,
      fsWriteBlocks: usage.fsWrite,
      voluntaryCtx: usage.voluntaryContextSwitches,
      involuntaryCtx: usage.involuntaryContextSwitches,
      maxRssKb: usage.maxRSS,
      wallMs: deps.wallMs(),
      targets,
    },
  };
}
