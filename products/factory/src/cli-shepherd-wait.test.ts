import type { JsonEnvelope } from "@titan-design/registry";
import { describe, expect, it } from "vitest";
import { EXIT, runCli, type CliDeps } from "./cli.js";
import { waitForPhase, type WaitOptions } from "./cli-shepherd-wait.js";
import type { Phase } from "./shepherd/step-phase.js";

const OPTIONS: WaitOptions = { ref: "acme/widgets#1", until: new Set<Phase>(["merging"]), timeoutMs: 60_000, intervalMs: 15_000 };

/** A status reader that answers each poll with the next phase, repeating the last, on a clock that only moves when the wait sleeps. */
function polls(phases: Phase[]): { ports: Parameters<typeof waitForPhase>[1]; err: () => string; reads: () => number } {
  let clock = 0;
  let reads = 0;
  let err = "";
  const readRows = async (): Promise<JsonEnvelope<unknown>> => ({ ok: true, data: [{ phase: phases[Math.min(reads++, phases.length - 1)] }] });
  const ports = { readRows, now: () => clock, sleep: async (ms: number) => void (clock += ms), stderr: (text: string) => void (err += text) };
  return { ports, err: () => err, reads: () => reads };
}

describe("shepherd wait", () => {
  it("exits 0 once the run reaches an --until phase", async () => {
    const { ports, err, reads } = polls(["ci", "review", "merging"]);

    const code = await waitForPhase(OPTIONS, ports);

    expect(code).toBe(EXIT.OK);
    expect(reads()).toBe(3);
    expect(err()).toBe("");
  });

  it("exits 1 naming the phase when the run ends in a phase not in --until", async () => {
    const { ports, err } = polls(["ci", "failed"]);

    const code = await waitForPhase(OPTIONS, ports);

    expect(code).toBe(EXIT.FAILURE);
    expect(err()).toBe("error: acme/widgets#1 ended in failed, not merging\n");
  });

  it("exits 1 with the last phase seen once the timeout passes", async () => {
    const { ports, err, reads } = polls(["ci"]);

    const code = await waitForPhase(OPTIONS, ports);

    expect(code).toBe(EXIT.FAILURE);
    expect(reads()).toBe(5);
    expect(err()).toBe("error: timed out after 60 s; acme/widgets#1 is still in ci\n");
  });

  it("exits 2 on an unknown --until phase without reading any status", async () => {
    let err = "";
    const deps: CliDeps = { workflows: [], routes: [] };

    const code = await runCli(["shepherd", "wait", "acme/widgets#1", "--until", "merging,landed"], { stdout: () => undefined, stderr: (text) => void (err += text), env: {} }, deps);

    expect(code).toBe(EXIT.USAGE);
    expect(err).toContain("unknown phase landed");
  });
});
