/** What every surface returns for a command: data on success, a message and code on failure. */
export type JsonEnvelope<T> =
  | { ok: true; data: T; warnings?: string[] }
  | { ok: false; error: string; code: number };

export function successEnvelope<T>(data: T, warnings?: string[]): JsonEnvelope<T> {
  if (warnings && warnings.length > 0) return { ok: true, data, warnings };
  return { ok: true, data };
}

export function errorEnvelope(error: string, code: number): JsonEnvelope<never> {
  return { ok: false, error, code };
}

/** BSD sysexits codes, the shared vocabulary for envelope `code` and CLI exit status. */
export const EXIT = {
  OK: 0,
  GENERIC: 1,
  USAGE: 64,
  DATAERR: 65,
  NOINPUT: 66,
  UNAVAILABLE: 69,
  SOFTWARE: 70,
  /** The output already exists and was not replaced; `POST /rpc/:name` answers 409. */
  CANTCREAT: 73,
  /** The caller is over a limit and may retry later; `POST /rpc/:name` answers 429. */
  TEMPFAIL: 75,
  /** The caller may not run this command; `POST /rpc/:name` answers 403. */
  NOPERM: 77,
  CONFIG: 78,
} as const;
