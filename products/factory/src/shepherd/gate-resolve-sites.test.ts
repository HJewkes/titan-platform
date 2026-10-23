import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathTouches } from "@titan-design/review-panel";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { SHEPHERD_CLASS_RULES } from "./g10-class-rules.js";
import { COMPILER_OPTIONS, GateResolveClosure, repoClosure, sourceProgram } from "./gate-resolve-closure.test-helpers.js";
import { adversaryTouches } from "./signoffs.js";

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
// About 20 s idle for one checker per unit; a loaded CI runner stretches wall time up to 10x (see vitest.config.ts).
const PROGRAM_TIMEOUT_MS = 300_000;

const isHeld = (path: string): boolean => adversaryTouches(pathTouches([{ path }], SHEPHERD_CLASS_RULES)).length > 0;

describe("the gate-resolve closure of the repo", () => {
  let closure: string[] = [];

  beforeAll(() => {
    closure = repoClosure(ROOT);
  }, PROGRAM_TIMEOUT_MS);

  it("is held g10-adversary, so a new resolve path cannot land without an adversary review", () => {
    expect(closure.filter((path) => !isHeld(path))).toEqual([]);
  });

  it.each([
    "products/factory/src/gate-resolve.ts",
    "products/factory/src/gate-answer-rpc.ts",
    "products/factory/src/gate-batch.ts",
    "products/factory/src/gate-notify.ts",
    "products/factory/src/console-action/outcome.ts",
    "products/factory/src/shepherd/round-ship-sweep.ts",
    "products/factory/src/needs/hitl-source.ts",
    "packages/queue-mirror/src/hitl.ts",
    "packages/queue-mirror/src/mirror.ts",
    "packages/workflow/src/runtime.ts",
    "packages/hitl/src/gate.ts",
  ])("finds the known resolve site %s", (path) => {
    expect(closure).toContain(path);
  });

  it("leaves out test files", () => {
    expect(closure.filter((path) => path.includes(".test."))).toEqual([]);
  });
});

const PROBE_HEADER = `import type { GateResolver, GateStore } from "@titan-design/hitl";
import type { WorkflowRuntime } from "@titan-design/workflow";
declare const host: { gates: GateStore; runtime: WorkflowRuntime; maybe?: { gates?: GateStore } };
`;
const PROBE_DIR = "products/factory/src/shepherd/probe";

/** Synthetic files written the ways the round-3 and round-4 adversary reviews found the regex scan missed (TP-4052). */
const PROBES: Record<string, string> = {
  "destructured-gates": `const { gates } = host;\nexport const answer = (r: GateResolver) => gates.resolve("g", {}, r);`,
  "optional-chain": `export const answer = (r: GateResolver) => host.maybe?.gates?.resolve("g", {}, r);`,
  "bracket-receiver": `export const answer = (r: GateResolver) => host["gates"].resolve("g", {}, r);`,
  "aliased-store": `const s = host.gates;\nexport const answer = (r: GateResolver) => s.resolve("g", {}, r);`,
  "factory-spread": `import { consoleResolver } from "../../console-action/outcome.js";\nexport const agent = { ...consoleResolver("x"), id: "agent" };`,
  "quoted-keys": `export const owner: GateResolver = { "class": "owner-remote", "channel": "x", id: "a" };`,
  "destructured-runtime": `const { runtime } = host;\nexport const answer = (r: GateResolver) => runtime.signal("run", "step", {}, r);`,
  "bare-receiver": `export const answer = (gates: GateStore, r: GateResolver) => gates.resolve("g", {}, r);`,
  "destructured-method": `const { resolve } = host.gates;\nexport const answer = (r: GateResolver) => resolve("g", {}, r);`,
  "bracket-method": `export const answer = (r: GateResolver) => host.gates["resolve"]("g", {}, r);`,
  "nested-literal": `export const answer = () => host.gates.resolve("g", {}, { class: "owner-remote", id: "a", channel: "x", confirmEvent: { e: { f: 1 } }.e.f.toString() });`,
  forwarder: `export function pass(store: GateStore, r: GateResolver) {\n  return store.resolve("g", {}, r);\n}`,
  "forwarder-caller": `import { pass } from "./forwarder.js";\nexport const answer = (r: GateResolver) => pass(host.gates, r);`,
  "queue-source": `import type { QueueSource } from "@titan-design/owner-queue";\nexport const source: QueueSource = { system: "hitl", open: async () => [], async *tail() {}, resolve: async () => ({ ok: true }) };`,
  "read-only": `export const read = (id: string) => host.gates.get(id);`,
};

/** A queue-mirror forwarder sits in that package, which the factory does not depend on. */
const MIRROR_PROBE = `import type { QueueSource } from "../types.js";
export const apply = (source: QueueSource, sender: string) => source.resolve("i", { verdict: "approve", resolutionEventId: "e", sender });
`;

const probePath = (name: string): string => join(ROOT, PROBE_DIR, `${name}.ts`);
const MIRROR_PROBE_PATH = join(ROOT, "packages/queue-mirror/src/probe/mirror-forward.ts");

function probeHost(files: Map<string, string>): ts.CompilerHost {
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const { getSourceFile, fileExists, readFile } = host;
  host.fileExists = (name) => files.has(name) || fileExists(name);
  host.readFile = (name) => files.get(name) ?? readFile(name);
  host.getSourceFile = (name, version, ...rest) => {
    const text = files.get(name);
    return text === undefined ? getSourceFile(name, version, ...rest) : ts.createSourceFile(name, text, version, true);
  };
  return host;
}

describe("a resolve site written the ways a name or regex scan misses", () => {
  let closure: string[] = [];

  beforeAll(() => {
    const files = new Map(Object.entries(PROBES).map(([name, body]) => [probePath(name), PROBE_HEADER + body]));
    files.set(MIRROR_PROBE_PATH, MIRROR_PROBE);
    const roots = [...files.keys()];
    closure = new GateResolveClosure(ROOT).scan(sourceProgram(roots, probeHost(files)), roots);
  }, PROGRAM_TIMEOUT_MS);

  it.each(Object.keys(PROBES).filter((name) => name !== "read-only"))("finds %s", (name) => {
    expect(closure).toContain(`${PROBE_DIR}/${name}.ts`);
  });

  it("finds a queue-mirror caller that picks the sender handed to QueueSource.resolve", () => {
    expect(closure).toContain("packages/queue-mirror/src/probe/mirror-forward.ts");
  });

  it("leaves out a file that only reads gates", () => {
    expect(closure).not.toContain(`${PROBE_DIR}/read-only.ts`);
  });
});
