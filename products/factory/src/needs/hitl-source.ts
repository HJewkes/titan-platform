import type { GateRecord, GateStore } from "@titan-design/hitl";
import type { ClosedStatus, OwnerItem, QueueSource, ResolveResult } from "@titan-design/owner-queue";
import { resolveCommand } from "../registry.js";
import { pollTail } from "./poll-tail.js";
import { summaryOf } from "./queue-read-error.js";

export type GateReader = Pick<GateStore, "get" | "listPending">;

interface HitlSourceOptions {
  gates: GateReader;
  pollMs?: number;
}

const CLOSED_AS: Record<GateRecord["status"], ClosedStatus> = {
  pending: "gone-elsewhere",
  resolved: "answered",
  cancelled: "withdrawn",
  expired: "expired",
};

/** Gate ids are `<runId>/<stepId>` or `<runId>/<stepId>:<n>`; a bare id names no run. */
const runOf = (gateId: string): string | undefined => (gateId.includes("/") ? gateId.slice(0, gateId.indexOf("/")) : undefined);

const stepOf = (gateId: string): string => gateId.slice(gateId.indexOf("/") + 1).replace(/:\d+$/, "");

/** A single question becomes the item's options; several stay in the context, where the gate's schema governs them. */
function choicesOf(gate: GateRecord): Pick<OwnerItem, "options" | "recommended"> {
  const questions = gate.questions ?? [];
  if (questions.length !== 1) return {};
  const options = questions[0]!.options;
  const pick = options.find((option) => option.recommended);
  return {
    options: options.map(({ id, label }) => ({ id, label })),
    ...(pick && { recommended: { optionId: pick.id, by: "titan-factory" } }),
  };
}

function contextOf(gate: GateRecord): string {
  const questions = (gate.questions ?? []).length > 1 ? gate.questions!.map((q) => `${q.id}: ${q.question} (${q.options.map((o) => o.id).join(" | ")})`) : [];
  return [gate.prompt, ...questions].join("\n");
}

/** Every factory gate holds a land or Shepherd run before its merge, and resolving one releases that run. */
function gateToOwnerItem(gate: GateRecord): OwnerItem {
  const runId = runOf(gate.id);
  return {
    id: `gate:${gate.id}`,
    sources: [{ system: "hitl", ref: gate.id }],
    kind: "approve",
    door: "one-way",
    summary: gate.summary ?? summaryOf(gate.prompt, `gate ${gate.id}`),
    context: contextOf(gate),
    ...(runId && { command: resolveCommand(runId, stepOf(gate.id)) }),
    ...choicesOf(gate),
    ...(gate.evidenceRef && { evidenceRef: gate.evidenceRef }),
    keys: [`gate:${gate.id}`, ...(runId ? [`run:${runId}`] : [])],
    personal: false,
    lens: "blocking-merge",
    unblocks: runId ? [`run:${runId}`] : [],
    ...(gate.rule && { authority: { table: gate.rule.table, ruleId: gate.rule.ruleId, resolvers: [...gate.rule.resolvers] } }),
    openedAt: gate.createdAt,
    ...(gate.expiresAt && { expiresAt: gate.expiresAt }),
    status: "open",
  };
}

/** Read-only until answers carry owner presence: a resolve goes through `titan-factory gate resolve`, which checks it. */
function resolve(gates: GateReader, ref: string): Promise<ResolveResult> {
  const gate = gates.get(ref);
  if (!gate || gate.status !== "pending") return Promise.resolve({ ok: false, reason: "closed" });
  return Promise.resolve({ ok: false, reason: "rejected", detail: "answer a factory gate with titan-factory gate resolve, which checks owner presence" });
}

/** The factory's own pending hitl gates. */
export function hitlGateSource({ gates, pollMs }: HitlSourceOptions): QueueSource {
  const open = (): Promise<OwnerItem[]> => Promise.resolve(gates.listPending().filter((gate) => gate.status === "pending").map(gateToOwnerItem));
  const closedAs = (ref: string): ClosedStatus => CLOSED_AS[gates.get(ref)?.status ?? "pending"];
  return { system: "hitl", open, tail: pollTail({ open, closedAs, intervalMs: pollMs }), resolve: (ref) => resolve(gates, ref) };
}
