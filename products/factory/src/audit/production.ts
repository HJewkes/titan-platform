import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { runAgent } from "@titan-design/agent";
import { parse } from "yaml";
import type { AuditAgent, AuditPorts } from "./ports.js";
import { inventoryStore, queryStore, runReadCommand } from "./probes.js";

const run = promisify(execFile);
/** A backstop against a runaway call, not a budget: spend is watched, not capped tight. */
const MAX_STEP_USD = 10;

/** One turn on the CLI login through `claude -p`; the schema makes the answer structured. */
export function claudePrintAgent(cwd: string): AuditAgent {
  return async ({ model, prompt, schema, signal }) => {
    const result = await runAgent({ harness: "claude-print", prompt, cwd, model, outputSchema: schema, maxTurns: 1, maxBudgetUsd: MAX_STEP_USD, signal });
    if (!result.ok) throw new Error(`${result.failure.kind}: ${result.failure.reason}`);
    return result.output;
  };
}

async function areaIds(checkout: string): Promise<string[]> {
  const { stdout } = await run(process.execPath, [join(checkout, "scripts", "areas.mjs")], { cwd: checkout });
  const parsed = parse(stdout) as { area?: { id: string }[] };
  return (parsed.area ?? []).map((area) => area.id);
}

/** The registry entry W2 keeps at `metrics/<area>.yml`; none yet is the first audit. */
async function priorEntry(checkout: string, system: string): Promise<unknown> {
  try {
    return parse(await readFile(join(checkout, "metrics", `${system}.yml`), "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The machine the audit reads: stores and surfaces read-only, the area registry and code from `checkout`. */
export function systemAuditPorts(checkout: string, agent: AuditAgent = claudePrintAgent(checkout)): AuditPorts {
  return {
    areas: () => areaIds(checkout),
    prior: (system) => priorEntry(checkout, system),
    codeRev: async () => (await run("git", ["-C", checkout, "rev-parse", "HEAD"])).stdout.trim(),
    now: Date.now,
    inventory: inventoryStore,
    query: queryStore,
    surface: runReadCommand,
    agent,
    writeReport: async (path, json) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, json);
    },
  };
}
