import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Policy } from "./fake-ports.js";

interface Effect {
  metrics?: Record<string, number>;
  violations?: Record<string, number>;
  by_key?: Record<string, { metrics?: Record<string, number>; violations?: Record<string, number> }>;
  micro?: boolean;
}

/** The fixture file's own shape, wider than `Policy`: effects per mechanism, `interactions`, and per-rung spend. */
type FilePolicy = Policy & {
  mechanisms: Record<string, Effect>;
  interactions?: Record<string, Effect>;
  usd?: { eval?: number; micro?: number };
};

const readPolicy = (policyPath: string) => JSON.parse(readFileSync(policyPath, "utf8")) as FilePolicy;

/** The tree's applied/ dir has one marker file per mechanism; an older fixture's applied.txt lists them one per line. */
function appliedIn(tree: string): string[] {
  const listed = existsSync(join(tree, "applied.txt")) ? readFileSync(join(tree, "applied.txt"), "utf8").split("\n").filter(Boolean) : [];
  return [...listed, ...(existsSync(join(tree, "applied")) ? readdirSync(join(tree, "applied")).sort() : [])];
}

/**
 * What a fixture evaluator reports for a tree: the policy's base metrics plus each applied mechanism's additive effect,
 * which a `by_key` entry overrides for one run label (the key's last `-` segment). An `interactions` entry named "a+b"
 * adds its effect only when every named mechanism is applied. The `noisy` metric gets ±sigma, its sign drawn from a hash
 * of the case, the label and the mechanisms, so its sd is exactly sigma and every run is reproducible.
 */
export function fakeEval(policyPath: string, tree: string, testCase: string, key: string): unknown {
  const policy = readPolicy(policyPath);
  const applied = appliedIn(tree);
  const interacting = Object.entries(policy.interactions ?? {}).filter(([names]) => names.split("+").every((name) => applied.includes(name)));
  const effects = [...applied.map((name) => policy.mechanisms[name] ?? {}), ...interacting.map(([, effect]) => effect)];
  const label = key.split("-").at(-1)!;
  const at = (effect: Effect, field: "metrics" | "violations", name: string) => effect.by_key?.[label]?.[field]?.[name] ?? effect[field]?.[name] ?? 0;
  const sum = (field: "metrics" | "violations", name: string) => effects.reduce((total, effect) => total + at(effect, field, name), 0);
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

/** A fixture micro rung: whether the mechanism's micro signal moves the predicted way (the default is yes), and its spend. */
export function fakeMicro(policyPath: string, rung: string, mechanism: string): unknown {
  const policy = readPolicy(policyPath);
  return { schema: "ar-micro/v1", rung, predicted_direction_met: policy.mechanisms[mechanism]?.micro ?? true, usd: policy.usd?.micro ?? 0 };
}
