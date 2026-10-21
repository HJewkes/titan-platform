#!/usr/bin/env bash
# Fixture evaluator for the autoresearch tests: usage fake_eval.sh <policy.json> <tree> <case> <key>.
# The tree's applied.txt names the mechanisms in it; policy.json gives the base metrics and each
# mechanism's additive effect, which a `by_key` entry overrides for one run key. The `noisy` metric
# gets ±sigma with its sign drawn from a hash of the case, the key and the mechanisms, so its sd is
# exactly sigma and every run is reproducible. Metric, gate and violation names are the policy's own.
set -euo pipefail
exec node -e '
const { readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const [policyPath, tree, testCase, key] = process.argv.slice(1);
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const applied = readFileSync(`${tree}/applied.txt`, "utf8").split("\n").filter(Boolean);
const mechanisms = applied.map((name) => policy.mechanisms[name] ?? {});
const at = (mechanism, field, name) => mechanism.by_key?.[key]?.[field]?.[name] ?? mechanism[field]?.[name] ?? 0;
const sum = (field, name) => mechanisms.reduce((total, mechanism) => total + at(mechanism, field, name), 0);
const sign = createHash("sha256").update([testCase, key, ...applied].join("\n")).digest()[0] & 1 ? 1 : -1;
const metrics = Object.fromEntries(Object.entries(policy.metrics).map(([name, base]) => [name, base + sum("metrics", name) + (name === policy.noisy ? sign * policy.sigma : 0)]));
process.stdout.write(JSON.stringify({
  schema: "ar-result/v2",
  case: testCase,
  repeat: key,
  metrics,
  gates: Object.fromEntries((policy.gates ?? []).map((name) => [name, true])),
  violations: Object.fromEntries((policy.violations ?? []).map((name) => [name, sum("violations", name)])),
  usd: 0,
  wall_s: 0,
}));
' "$@"
