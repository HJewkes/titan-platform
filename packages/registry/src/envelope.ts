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
  CONFIG: 78,
} as const;

export interface ErrorDescription {
  message: string;
  code: number;
}

/** Read a thrown value's message and numeric `code`, falling back to EXIT.GENERIC. */
export function describeError(err: unknown): ErrorDescription {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { message: err.message, code: typeof code === "number" ? code : EXIT.GENERIC };
  }
  return { message: String(err), code: EXIT.GENERIC };
}
