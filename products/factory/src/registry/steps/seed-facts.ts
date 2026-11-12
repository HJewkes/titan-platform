import { z } from "zod";
import { defineStep, type FactEntry } from "../entry.js";
import { effect, irreversible, READ_EFFECT, RECORD, step, WRITE } from "./helpers.js";

const idempotencyKey = (input: unknown): string => JSON.stringify(input);

/** The legacy entries promoted to fact entries, so the registry lints run on real code (TP-3106 S5). */
export const seedFactSteps: readonly FactEntry[] = [
  defineStep({
    ...step("ci-wait", "dispatch", "software", READ_EFFECT),
    version: { bump: 2 },
    fact: "ci:green",
    input: z.object({ repo: z.string(), pr: z.number() }),
    output: z.looseObject({ verdict: z.string(), headSha: z.string(), mergeableState: z.string() }),
    materialInputs: [{ fact: "head:pushed", fields: ["head"] }],
    projection: ["verdict", "headSha", "mergeableState"],
    idempotencyKey,
    body: "products/factory/src/workflows/land-ci-wait.ts",
  }),
  defineStep({
    ...step("sh-await-verdict", "dispatch", "AGENT", effect("item", `${RECORD}: the reviewer's verdict at a head`)),
    fact: "verdict:merge",
    input: z.object({ head: z.string() }),
    output: z.looseObject({ outcome: z.enum(["MERGE", "FIX_FIRST", "no-verdict", "timeout"]), head: z.string() }),
    materialInputs: [{ fact: "head:pushed", fields: ["head"] }],
    projection: ["outcome", "head"],
    idempotencyKey,
    body: "products/factory/src/shepherd/await-verdict.ts",
  }),
  defineStep({
    ...step("merge", "dispatch", "software", irreversible("pr", `${WRITE}: merges the PR on GitHub`)),
    fact: "landed",
    input: z.object({ repo: z.string(), pr: z.number(), sha: z.string(), method: z.string() }),
    output: z.looseObject({ done: z.boolean(), skipped: z.string().optional(), mergeSha: z.string() }),
    materialInputs: [{ fact: "ci:green", fields: ["headSha"] }],
    projection: ["done", "skipped", "mergeSha"],
    idempotencyKey,
    body: "products/factory/src/workflows/land-steps.ts",
  }),
];
