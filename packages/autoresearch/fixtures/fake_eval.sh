#!/usr/bin/env bash
# Fixture evaluator for the autoresearch tests: usage fake_eval.sh <policy.json> <tree> <case> <key>.
# The tree's applied/ dir has one marker file per mechanism in it, so two ideas merge cleanly; an older
# fixture's applied.txt lists them one per line. policy.json gives the base metrics and each
# mechanism's additive effect, which a `by_key` entry overrides for one run label (the key's last
# `-` segment, so `r2` matches every idea's second repeat). An `interactions` entry named "a+b" adds
# its effect only when every named mechanism is in the tree. The `noisy` metric
# gets ±sigma with its sign drawn from a hash of the case, the label and the mechanisms, so its sd is
# exactly sigma and every run is reproducible. Metric, gate and violation names are the policy's own.
# The key is echoed as `repeat`, and the run's artifact dir is named after it, as a real target does.
set -euo pipefail
exec node -e '
const { existsSync, readdirSync, readFileSync } = require("node:fs");
const { createHash } = require("node:crypto");
const [policyPath, tree, testCase, key] = process.argv.slice(1);
const policy = JSON.parse(readFileSync(policyPath, "utf8"));
const listed = existsSync(`${tree}/applied.txt`) ? readFileSync(`${tree}/applied.txt`, "utf8").split("\n").filter(Boolean) : [];
const applied = [...listed, ...(existsSync(`${tree}/applied`) ? readdirSync(`${tree}/applied`).sort() : [])];
const interacting = Object.entries(policy.interactions ?? {}).filter(([names]) => names.split("+").every((name) => applied.includes(name)));
const mechanisms = [...applied.map((name) => policy.mechanisms[name] ?? {}), ...interacting.map(([, effect]) => effect)];
const label = key.split("-").at(-1);
const at = (mechanism, field, name) => mechanism.by_key?.[label]?.[field]?.[name] ?? mechanism[field]?.[name] ?? 0;
const sum = (field, name) => mechanisms.reduce((total, mechanism) => total + at(mechanism, field, name), 0);
const sign = createHash("sha256").update([testCase, label, ...applied].join("\n")).digest()[0] & 1 ? 1 : -1;
const metrics = Object.fromEntries(Object.entries(policy.metrics).map(([name, base]) => [name, base + sum("metrics", name) + (name === policy.noisy ? sign * policy.sigma : 0)]));
process.stdout.write(JSON.stringify({
  schema: "ar-result/v2",
  case: testCase,
  repeat: key,
  metrics,
  gates: Object.fromEntries((policy.gates ?? []).map((name) => [name, true])),
  violations: Object.fromEntries((policy.violations ?? []).map((name) => [name, sum("violations", name)])),
  usd: policy.usd?.eval ?? 0,
  wall_s: 0,
  artifact_dir: `${tree}/.artifacts/${key}`,
}));
' "$@"
