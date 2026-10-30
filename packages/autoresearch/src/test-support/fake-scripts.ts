import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Policy } from "./fake-ports.js";

const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
const readPolicy = (path: string): Policy => JSON.parse(readFileSync(path, "utf8"));

/**
 * The fixture evaluator. The tree's applied/ dir has one marker file per mechanism in it, so two ideas merge cleanly;
 * an older fixture's applied.txt lists them one per line. A `by_key` entry overrides a mechanism's effect for one run
 * label (the key's last `-` segment, so `r2` matches every idea's second repeat), and an `interactions` entry named
 * "a+b" adds its effect only when every named mechanism is in the tree. The `noisy` metric gets ±sigma with its sign
 * drawn from a hash of the case, the label and the mechanisms, so its sd is exactly sigma and every run is reproducible.
 * The key is echoed as `repeat`, and the run's artifact dir is named after it, as a real target does.
 */
export function fakeEval(policyPath: string, tree: string, testCase: string, key: string): unknown {
  const policy = readPolicy(policyPath);
  const applied = [...lines(`${tree}/applied.txt`), ...(existsSync(`${tree}/applied`) ? readdirSync(`${tree}/applied`).sort() : [])];
  const interacting = Object.entries(policy.interactions ?? {}).filter(([names]) => names.split("+").every((name) => applied.includes(name)));
  const mechanisms = [...applied.map((name) => policy.mechanisms[name] ?? {}), ...interacting.map(([, effect]) => effect)];
  const label = key.split("-").at(-1)!;
  const at = (mechanism: (typeof mechanisms)[number], field: "metrics" | "violations", name: string) =>
    mechanism.by_key?.[label]?.[field]?.[name] ?? mechanism[field]?.[name] ?? 0;
  const sum = (field: "metrics" | "violations", name: string) => mechanisms.reduce((total, mechanism) => total + at(mechanism, field, name), 0);
  const sign = createHash("sha256").update([testCase, label, ...applied].join("\n")).digest()[0]! & 1 ? 1 : -1;
  const metrics = Object.fromEntries(Object.entries(policy.metrics).map(([name, base]) => [name, base + sum("metrics", name) + (name === policy.noisy ? sign * policy.sigma : 0)]));
  return {
    schema: "ar-result/v2",
    case: testCase,
    repeat: key,
    metrics,
    gates: Object.fromEntries((policy.gates ?? []).map((name) => [name, true])),
    violations: Object.fromEntries((policy.violations ?? []).map((name) => [name, sum("violations", name)])),
    usd: policy.usd?.eval ?? 0,
    wall_s: 0,
    artifact_dir: `${tree}/.artifacts/${key}`,
  };
}

/** The fixture micro rung: the policy entry says whether the micro signal moves the predicted way (default yes). */
export function fakeMicro(policyPath: string, tree: string, rung: string, mechanism: string): unknown {
  const policy = readPolicy(policyPath);
  return { schema: "ar-micro/v1", rung, predicted_direction_met: policy.mechanisms[mechanism]?.micro ?? true, usd: policy.usd?.micro ?? 0 };
}
