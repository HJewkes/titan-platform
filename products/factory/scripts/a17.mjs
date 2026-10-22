#!/usr/bin/env node
// Runs the factory's A17 cases under vitest and checks every one passed in both sources modes (TP-3102 H2).
// usage: a17.mjs [--out <path>] [vitest file filters...]; exits 1 when the report is not ok, 2 when vitest wrote none.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkA17Report } from "../src/test-support/a17/report.ts";
import { NOT_EVENT } from "../src/test-support/a17/not-event.ts";


const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt === -1 ? undefined : args.splice(outAt, 2)[1];
const filters = args.length > 0 ? args : ["products/factory/"];

const scratch = mkdtempSync(join(tmpdir(), "a17-"));
const jsonPath = join(scratch, "vitest.json");
try {
  spawnSync("pnpm", ["exec", "vitest", "run", "-t", "A17:", "--reporter=json", `--outputFile=${jsonPath}`, ...filters], { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] });
  let json;
  try {
    json = JSON.parse(readFileSync(jsonPath, "utf8"));
  } catch {
    console.error("a17: vitest wrote no JSON report");
    process.exit(2);
  }
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const report = checkA17Report(json, { sha, generatedAt: new Date().toISOString(), notEvent: NOT_EVENT });
  for (const c of report.cases) console.log(`${c.title}: webhook ${c.webhook}, polling ${c.polling}`);
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) console.error(`a17: not ok, one-mode or non-passing: ${report.oneMode.join("; ") || "no A17 case ran"}`);
  process.exitCode = report.ok ? 0 : 1;
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
