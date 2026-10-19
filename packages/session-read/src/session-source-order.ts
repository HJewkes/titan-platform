import type { NormalizedSessionObservation, SessionSourceDescriptor } from "./normalized.js";

/**
 * Visits one already-selected session source in physical source order.
 * Claude streaming/native content emission remains unchanged. Codex fallback
 * messages can be emitted at a later turn boundary, so buffer that source before
 * consumer counters or policy projections run. This does not discover sources,
 * infer completion, authenticate identity, or grant investigative credit.
 */
export async function* inSessionSourceOrder(
  source: SessionSourceDescriptor,
  observations: AsyncIterable<NormalizedSessionObservation>,
): AsyncGenerator<NormalizedSessionObservation> {
  if (source.harness !== "codex") {
    yield* observations;
    return;
  }
  const buffered: NormalizedSessionObservation[] = [];
  for await (const observation of observations) buffered.push(observation);
  // Stable sort retains decoder subrecord order within each physical record.
  buffered.sort((left, right) => left.evidence.line.byteOffset - right.evidence.line.byteOffset);
  yield* buffered;
}
