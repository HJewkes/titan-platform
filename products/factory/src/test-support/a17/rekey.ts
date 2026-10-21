import { z } from "zod";
import { ciKey, type CiKeyFn, type CiObservation } from "../../event-log/ci-keys.js";
import type { Projector } from "../../ingress/answer.js";
import type { Observation } from "../../reconciler/service.js";

interface KeyedEvent {
  rule: "identity" | "transition";
  kind: string;
  repo?: string;
  subject: string;
  keys: Record<string, unknown>;
  payload: unknown;
}

const CiPayload = z.object({ type: z.enum(["check", "status"]), at: z.string() });

/** A CIConcluded row carries every field its key reads: the head in the subject, the rest in `keys` and `payload`. */
function observationOf(event: KeyedEvent): CiObservation {
  const payload = CiPayload.parse(event.payload);
  const checkRunId = typeof event.keys.checkRunId === "number" ? event.keys.checkRunId : undefined;
  const head = event.subject.slice(event.subject.indexOf("@") + 1);
  return { type: payload.type, repo: event.repo ?? "", head, context: String(event.keys.context), outcome: String(event.keys.outcome), at: payload.at, ...(checkRunId !== undefined && { checkRunId }) };
}

function rekey<E extends KeyedEvent>(event: E, key: CiKeyFn): E {
  if (key === ciKey || event.rule !== "identity" || event.kind !== "CIConcluded") return event;
  return { ...event, occurrenceKey: key(observationOf(event)) };
}

/**
 * The production ingress and observe always key with `ciKey`. A harness case that proves the key matters re-keys their
 * CIConcluded events on the way to the append, so both sources still share one key function.
 */
export function rekeyedProjection(projected: ReturnType<Projector>, key: CiKeyFn): ReturnType<Projector> {
  return projected === "ignored" ? projected : rekey(projected, key);
}

export function rekeyedObservation(observation: Observation, key: CiKeyFn): Observation {
  return { ...observation, events: observation.events.map((event) => rekey(event, key)) };
}
