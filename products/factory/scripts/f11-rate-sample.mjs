#!/usr/bin/env node
// The HJewkes side of the F11 meter: run as the identity being measured, it samples `gh api rate_limit` every minute
// and appends one JSONL record per sample. The bot side is serve's own github-api.peak lines.
// usage: f11-rate-sample.mjs --out <jsonl> [--rounds <n>]
//        f11-rate-sample.mjs --peaks <jsonl>   prints the max used per (resource, reset) window as JSON
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { setTimeout as wait } from "node:timers/promises";
import { promisify } from "node:util";
import { ratePeaks, runRateSampler } from "../src/github-api/rate-sample.ts";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const peaksOf = flag("--peaks");
const out = flag("--out");
if (peaksOf !== undefined) {
  const records = readFileSync(peaksOf, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  console.log(JSON.stringify(ratePeaks(records), null, 2));
} else if (out !== undefined) {
  const rounds = flag("--rounds");
  await runRateSampler({
    gh: async () => (await promisify(execFile)("gh", ["api", "rate_limit"])).stdout,
    append: (line) => appendFileSync(out, line),
    warn: (message) => console.error(message),
    now: () => new Date(),
    wait,
    rounds: rounds === undefined ? undefined : Number(rounds),
  });
} else {
  console.error("usage: f11-rate-sample.mjs --out <jsonl> [--rounds <n>] | --peaks <jsonl>");
  process.exitCode = 2;
}
