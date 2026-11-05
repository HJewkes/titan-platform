/** Message of a caught value; a thrown non-Error prints as `String(err)`. */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A caught value as an Error, so callers can carry it in an `Error`-typed field. */
export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}
