import { Clusterer } from "@titan-design/cluster";
import type { GateRun } from "./schemas.js";

/** What a gate's record says went wrong, as `failure.class`: the code under test, the machine, the gate itself, or the build spec. */
export const GATE_FAILURE_CLASSES = ["code", "infra", "gate-broken", "spec"] as const;
export type GateFailureClass = (typeof GATE_FAILURE_CLASSES)[number];

/** `fix` resumes the implementer; `retry` probes health, reruns the gates once and then parks; `stop` ends the slice and files a task. */
export type GateRoute = "fix" | "retry" | "stop";

/** The one routing table for a failing gate. */
export const GATE_ROUTE_TABLE: Readonly<Record<GateFailureClass, GateRoute>> = { code: "fix", infra: "retry", "gate-broken": "stop", spec: "stop" };

/** A fix round cannot repair a broken gate, and a code failure seen on a sick machine is not yet worth one. */
const ROUTE_ORDER: readonly GateRoute[] = ["stop", "retry", "fix"];

/** An absent or unrecognized class reads as `code`: the fix loop is the route the round and no-improvement caps already bound. */
export function gateFailureClass(raw: string | undefined): GateFailureClass {
  return (GATE_FAILURE_CLASSES as readonly string[]).includes(raw ?? "") ? (raw as GateFailureClass) : "code";
}

type GateRow = GateRun["gates"][number];

const failing = (gates: GateRun): GateRow[] => gates.gates.filter((gate) => !gate.pass);
const routeOf = (gate: GateRow): GateRoute => GATE_ROUTE_TABLE[gateFailureClass(gate.failure?.class)];

/** The route of a red gate run. A red run with no failing record, a command that died before writing one, goes to `fix`. */
export function gateRunRoute(gates: GateRun): GateRoute {
  const routes = new Set(failing(gates).map(routeOf));
  return ROUTE_ORDER.find((route) => routes.has(route)) ?? "fix";
}

export interface FailureGroup {
  /** The cluster's template id, stable for a signature, so a repeat of the failure finds the task already filed. */
  id: string;
  class: GateFailureClass;
  signature: string;
  gates: GateRow[];
}

/** The failing gates on `route`, one group per failure signature; classes never share a group. */
export function failureGroups(gates: GateRun, route: GateRoute): FailureGroup[] {
  const clusterer = new Clusterer();
  const groups = new Map<string, FailureGroup>();
  for (const gate of failing(gates).filter((row) => routeOf(row) === route)) {
    const failureClass = gateFailureClass(gate.failure?.class);
    const signature = gate.failure?.signature ?? gate.gate;
    const { templateId } = clusterer.cluster({ partition: failureClass, text: signature });
    const group = groups.get(templateId) ?? { id: templateId, class: failureClass, signature, gates: [] };
    groups.set(templateId, { ...group, gates: [...group.gates, gate] });
  }
  return [...groups.values()];
}
