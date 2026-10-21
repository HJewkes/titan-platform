#!/usr/bin/env bash
# Fixture evaluator for the autoresearch tests: usage fake_eval.sh <policy.json> <tree> <seed> <key>.
# The tree's applied.txt names the mechanisms in it; policy.json gives each one's effect. The noise is
# ±sigma with its sign drawn from a hash of the seed, the key and the mechanisms, so its sd is exactly
# sigma and every run is reproducible.
set -euo pipefail
exec node -e '
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const [policyPath, tree, seed, key] = process.argv.slice(1);
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const applied = readFileSync(`${tree}/applied.txt`, "utf8").split("\n").filter(Boolean);
const mechanisms = applied.map((name) => policy.mechanisms[name] ?? {});
const at = (mechanism, field, fallback) => mechanism[`${field}_by_key`]?.[key] ?? mechanism[field] ?? fallback;
const sum = (field) => mechanisms.reduce((total, mechanism) => total + at(mechanism, field, 0), 0);
const sign = createHash("sha256").update([seed, key, ...applied].join("\n")).digest()[0] & 1 ? 1 : -1;
process.stdout.write(JSON.stringify({
  schema: "ar-result/v1",
  seed,
  repeat: key,
  all_gate: !mechanisms.some((mechanism) => at(mechanism, "gate_fail", false)),
  hidden_regressions: sum("hidden"),
  cc_total_delta_pct: policy.base_cc + sum("cc") + sign * policy.sigma,
  single_caller_delta: sum("single_caller"),
  accepted_tasks: mechanisms.some((mechanism) => at(mechanism, "noop", false)) ? 0 : policy.accepted_tasks,
  usd: 0,
}));
' "$@"
