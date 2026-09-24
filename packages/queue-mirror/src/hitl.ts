import type { GateRecord, GateStatus, GateStore } from "@titan-design/hitl";
import { abortableSleep } from "./supervise.js";
import type { CloseOutcome, QueueItem, QueueSource, ResolveResult, SourceEvent, VerdictInput } from "./types.js";

type GateKind = "approval_request" | "question";
export type GateAction = { resolve: unknown } | { cancel: string };

export interface HitlSourceOptions {
  /** TitanItem headline fields. */
  machine: string;
  session: string;
  /** hitl has no change feed, so tail polls listPending at this interval. */
  pollMs?: number;
  kindOf?: (gate: GateRecord) => GateKind;
  toPayload?: (gate: GateRecord, verdict: VerdictInput) => GateAction;
}

const DEFAULT_POLL_MS = 1_000;
// Matched by name, so a second hitl copy in node_modules cannot break instanceof.
const CLOSED_ERRORS = new Set(["GateAlreadySettled", "GateExpired", "GateNotFound"]);
const OUTCOMES: Record<Exclude<GateStatus, "pending">, CloseOutcome> = { resolved: "resolved", cancelled: "cancelled", expired: "expired" };

const defaultKind = (gate: GateRecord): GateKind => (gate.schema ? "question" : "approval_request");

/** allow and approve resolve {approved: true}; an answer resolves its text; deny and dismiss cancel. */
export function defaultGatePayload(_gate: GateRecord, { verdict, text }: VerdictInput): GateAction {
  if (verdict === "allow" || verdict === "approve") return { resolve: { approved: true } };
  if (verdict === "answer") return { resolve: text };
  return { cancel: "denied from Matrix" };
}

function errorResult(err: unknown): ResolveResult {
  const name = err instanceof Error ? err.name : "";
  const detail = err instanceof Error ? err.message : String(err);
  if (CLOSED_ERRORS.has(name)) return { ok: false, reason: "closed", detail };
  if (name === "GatePayloadInvalid") return { ok: false, reason: "rejected", detail };
  throw err;
}

class HitlQueueSource implements QueueSource {
  readonly kinds = ["approval_request", "question"] as const;

  constructor(
    private readonly store: GateStore,
    private readonly options: HitlSourceOptions,
  ) {}

  async open(): Promise<QueueItem[]> {
    return this.store.listPending().map((gate) => this.toItem(gate));
  }

  async resolve(id: string, verdict: VerdictInput): Promise<ResolveResult> {
    const gate = this.store.get(id);
    if (gate?.status !== "pending") return { ok: false, reason: "closed" };
    const action = (this.options.toPayload ?? defaultGatePayload)(gate, verdict);
    try {
      if ("resolve" in action) this.store.resolve(id, action.resolve);
      else this.store.cancel(id, action.cancel);
      return { ok: true };
    } catch (err) {
      return errorResult(err);
    }
  }

  /** The cursor only numbers events; after a restart, reconcile over open() is what catches up. */
  async *tail(_cursor: string | undefined, signal: AbortSignal): AsyncIterable<SourceEvent> {
    const known = new Set<string>();
    let seq = 0;
    while (!signal.aborted) {
      for (const event of this.diff(known)) yield { ...event, cursor: String(++seq) } as SourceEvent;
      await abortableSleep(this.options.pollMs ?? DEFAULT_POLL_MS, signal);
    }
  }

  private diff(known: Set<string>): Array<Omit<SourceEvent, "cursor">> {
    const pending = this.store.listPending();
    const pendingIds = new Set(pending.map((gate) => gate.id));
    const closed = [...known].filter((id) => !pendingIds.has(id)).map((id) => this.closedEvent(id));
    const opened = pending.filter((gate) => !known.has(gate.id)).map((gate) => ({ type: "opened" as const, item: this.toItem(gate) }));
    for (const id of pendingIds) known.add(id);
    for (const event of closed) known.delete(event.id);
    return [...closed, ...opened];
  }

  private closedEvent(id: string): { type: "closed"; id: string; outcome: CloseOutcome; label?: string } {
    const gate = this.store.get(id);
    const outcome = gate && gate.status !== "pending" ? OUTCOMES[gate.status] : "cancelled";
    return { type: "closed", id, outcome, label: gate?.reason };
  }

  private toItem(gate: GateRecord): QueueItem {
    const kind = (this.options.kindOf ?? defaultKind)(gate);
    const { machine, session } = this.options;
    const prompt = kind === "approval_request" ? { toolName: "gate", inputPreview: gate.prompt } : { text: gate.prompt };
    const expiresAt = gate.expiresAt === undefined ? undefined : Date.parse(gate.expiresAt);
    return { id: gate.id, kind, machine, session, at: Date.parse(gate.createdAt), expiresAt, ...prompt };
  }
}

/** A QueueSource over a hitl GateStore: pending gates become approval_request or question items. */
export function hitlQueueSource(store: GateStore, options: HitlSourceOptions): QueueSource {
  return new HitlQueueSource(store, options);
}
