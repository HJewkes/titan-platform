import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueOpsSchema, type Digest } from "@titan-design/autoresearch";
import { partialFake } from "@titan-design/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { plannerResumeBrief, plannerSpawnBrief, resumeContract } from "./planner-brief.js";

let clone: string;
const input = { runId: "run-7", round: 1, digest: partialFake<Digest>({ round: 1, evidence: [] }), violations: ["no bold idea and no [EXEMPT] reason"], quota: { keptLastRound: ["i-kept"], minPool: 9, queuedBefore: 4 }, mode: "spawn" as const };
const target = () => ({ name: "demo", clone, adapterDir: "adapter" });

const ContractSchema = z.object({ properties: z.record(z.string(), z.object({ items: z.object({ required: z.array(z.string()) }).partial().optional() })), required: z.array(z.string()).optional() });

/** The JSON Schema is everything after the "End contract" line. */
const contractSchema = (brief: string) => ContractSchema.parse(JSON.parse(brief.slice(brief.indexOf("\n", brief.indexOf("End contract:")) + 1)));

beforeEach(() => {
  clone = mkdtempSync(join(tmpdir(), "ar-planner-brief-"));
  mkdirSync(join(clone, "adapter"));
});

afterEach(() => rmSync(clone, { recursive: true, force: true }));

describe("the planner's spawn brief", () => {
  it("carries the program text, the run and target identity, and the round input", () => {
    writeFileSync(join(clone, "adapter", "program.md"), "# Program\nMake the gate faster without losing recall.\n");

    const brief = plannerSpawnBrief(target(), input);

    expect(brief).toContain("Make the gate faster without losing recall.");
    expect(brief).toContain("run-7");
    expect(brief).toContain("target demo");
    expect(brief).toContain(join(clone, "adapter", "bounds.json"));
    expect(brief).toContain('"violations":["no bold idea and no [EXEMPT] reason"]');
  });

  it("points at the program path when the clone has no program file", () => {
    const brief = plannerSpawnBrief(target(), input);

    expect(brief).toContain(`Read the program at ${join(clone, "adapter", "program.md")} first.`);
  });

  it("ends with the queue-ops JSON Schema the engine parses the answer with", () => {
    const schema = contractSchema(plannerSpawnBrief(target(), input));

    expect(Object.keys(schema.properties)).toEqual(Object.keys(QueueOpsSchema.shape));
    expect(schema.required ?? []).toEqual([]);
    expect(schema.properties.add!.items!.required).toEqual(expect.arrayContaining(["hypothesis", "mechanism", "class", "targets", "expectedEffect", "testPlan", "bold"]));
  });
});

describe("both planner briefs", () => {
  it("state this round's quota numbers from the run settings", () => {
    for (const brief of [plannerSpawnBrief(target(), input), plannerResumeBrief({ ...input, round: 2, mode: "resume" })]) {
      expect(brief).toContain("a candidate pool of at least 9: the queue holds 4, so adds minus drops must be at least 5");
      expect(brief).toContain("parent set to each kept idea (i-kept)");
    }
  });
});

describe("the planner's resume brief", () => {
  it("restates the end contract in one line after the round input", () => {
    const brief = plannerResumeBrief({ ...input, round: 3, mode: "resume" });

    expect(brief.split("\n").at(-1)).toBe(resumeContract);
    expect(resumeContract).toContain(Object.keys(QueueOpsSchema.shape).join(", "));
    expect(brief).toContain('"round":3');
  });
});
