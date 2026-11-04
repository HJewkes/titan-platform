import { F11_KINDS } from "../event-log/f11-report.js";
import { RECONCILER_KINDS } from "../reconciler/kinds.js";
import { isFactEntry, type FactEntry, type StepEntry } from "./entry.js";
import type { FactRule } from "./pin-classes.js";

interface Violation {
  lint: string;
  subject: string;
  message: string;
}

interface RegistryView {
  readonly entries: readonly StepEntry[];
}

/** Pools whose claim outlives one step; v9.1 §2.2 lets such a claim open only from a start set. */
const LONG_SCOPE_POOLS: readonly string[] = ["contract-path"];

const factEntries = (registry: RegistryView): FactEntry[] => registry.entries.filter(isFactEntry);

/** A dependent may read only what its producer projects: a field outside the projection is not part of the fact's identity. */
export function lintProjectionCoversReads(registry: RegistryView): Violation[] {
  const facts = factEntries(registry);
  return facts.flatMap((reader) =>
    reader.materialInputs.flatMap((input) => {
      const producer = facts.find((candidate) => candidate.fact === input.fact);
      const outside = producer ? input.fields.filter((field) => !producer.projection.includes(field)) : [];
      return outside.map((field) => ({
        lint: "projection-covers-reads",
        subject: reader.name,
        message: `reads "${input.fact}.${field}", which ${producer?.name} does not project`,
      }));
    }),
  );
}

/** An observed fact is reset by an event kind some source emits, or it expires on a TTL. */
export function lintObservedProducers(rules: Readonly<Record<string, FactRule>>): Violation[] {
  const emitted = new Set([...RECONCILER_KINDS.flatMap((row) => row.kinds), ...F11_KINDS]);
  return Object.entries(rules)
    .filter(([, rule]) => rule.pinClass === "observed")
    .flatMap(([fact, rule]) => {
      const violation = (message: string): Violation => ({ lint: "observed-producers", subject: fact, message });
      if (!rule.ttl && !rule.producer?.length) return [violation("has neither a producer kind nor a TTL")];
      return (rule.producer ?? []).filter((kind) => !emitted.has(kind)).map((kind) => violation(`names producer kind "${kind}", which no source emits`));
    });
}

/** A claim in a long-scope pool must sit on a start-set entry. */
export function lintLongClaims(registry: RegistryView): Violation[] {
  return registry.entries
    .filter((entry) => !entry.startSet)
    .flatMap((entry) =>
      (entry.claims ?? [])
        .filter((claim) => LONG_SCOPE_POOLS.includes(claim.pool))
        .map((claim) => ({ lint: "long-claims", subject: entry.name, message: `claims long-scope pool "${claim.pool}" outside a start set` })),
    );
}

/** A fact entry projects something and its body module exists. */
export function lintFactEntries(registry: RegistryView, bodyExists: (path: string) => boolean): Violation[] {
  return factEntries(registry).flatMap((entry) => {
    const violation = (message: string): Violation => ({ lint: "fact-entries", subject: entry.name, message });
    return [
      ...(entry.projection.length === 0 ? [violation("has an empty projection")] : []),
      ...(bodyExists(entry.body) ? [] : [violation(`body "${entry.body}" does not exist`)]),
    ];
  });
}
