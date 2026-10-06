/** The result every enricher reports when its caller-supplied resolver throws. */
interface ResolverFailure {
  requested: number;
  applied: 0;
  failed: true;
  error: string;
}

type ResolverOutcome<T> = { ok: true; value: T } | { ok: false; failure: ResolverFailure };

/**
 * Only the resolver is soft-failed: it is the caller's external dependency, so its
 * failure costs a pass its enrichment. The enricher's own writes run outside this,
 * so a defect in our store propagates instead of passing as a resolver failure.
 */
export async function callResolver<T>(requested: number, resolve: () => PromiseLike<T> | T): Promise<ResolverOutcome<T>> {
  try {
    return { ok: true, value: await resolve() };
  } catch (err) {
    return { ok: false, failure: { requested, applied: 0, failed: true, error: err instanceof Error ? err.message : String(err) } };
  }
}
