#!/usr/bin/env node
// Determinism check: renders the frame matrix twice into fresh directories and compares the
// SHA-256 of every PNG, SVG and metrics file. Identical inputs must give byte-identical output.
// Usage: node tools/l1-protos/determinism.mjs <snapshot.json> <reportDir> <playwright-core dir> [chromium]
// Writes <reportDir>/determinism.json and exits 1 on any mismatch. L1_FRAMES limits the frames.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [snapshot, reportArg, ...rest] = process.argv.slice(2);
const reportDir = path.resolve(reportArg);
const matrix = path.join(path.dirname(fileURLToPath(import.meta.url)), "matrix.mjs");

function runMatrix(dir) {
  const run = spawnSync("node", [matrix, snapshot, dir, ...rest], { env: process.env, encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`matrix failed: ${run.stderr.slice(-2000)}`);
}

function hashes(dir) {
  const out = {};
  for (const f of readdirSync(dir).filter((n) => /\.(png|svg|json)$/.test(n)).sort()) out[f] = createHash("sha256").update(readFileSync(path.join(dir, f))).digest("hex");
  return out;
}

mkdirSync(reportDir, { recursive: true });
const work = mkdtempSync(path.join(reportDir, ".l1-determinism-"));
try {
  const [a, b] = ["first", "second"].map((n) => path.join(work, n));
  runMatrix(a);
  runMatrix(b);
  const [ha, hb] = [hashes(a), hashes(b)];
  const files = [...new Set([...Object.keys(ha), ...Object.keys(hb)])].sort();
  const mismatches = files.filter((f) => ha[f] !== hb[f]);
  const report = { files: files.length, mismatches, hashes: Object.fromEntries(files.map((f) => [f, { first: ha[f], second: hb[f] }])) };
  writeFileSync(path.join(reportDir, "determinism.json"), JSON.stringify(report, null, 1));
  console.log(`${files.length} files compared, ${mismatches.length} mismatches${mismatches.length ? `: ${mismatches.join(", ")}` : ""}`);
  process.exitCode = mismatches.length ? 1 : 0;
} finally {
  rmSync(work, { recursive: true, force: true });
}
