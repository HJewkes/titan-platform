export type TtsErrorCode = "unavailable" | "unsupported" | "timeout" | "failed";

/** Every error this package throws. Branch on `code`, not on the message. */
export class TtsError extends Error {
  constructor(
    readonly code: TtsErrorCode,
    readonly providerId: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`${providerId}: ${message}`, options);
    this.name = "TtsError";
  }
}

/** The engine cannot be reached: missing binary, refused connection, nothing configured. */
export class TtsUnavailableError extends TtsError {
  constructor(providerId: string, message: string, options?: { cause?: unknown }) {
    super("unavailable", providerId, message, options);
    this.name = "TtsUnavailableError";
  }
}

/** The request needs something the provider's capabilities do not list. `missing` names each gap. */
export class TtsUnsupportedError extends TtsError {
  constructor(
    providerId: string,
    readonly missing: readonly string[],
    message = `lacks ${missing.join(", ")}`,
  ) {
    super("unsupported", providerId, message);
    this.name = "TtsUnsupportedError";
  }
}

export class TtsTimeoutError extends TtsError {
  constructor(
    providerId: string,
    readonly timeoutMs: number,
  ) {
    super("timeout", providerId, `no audio within ${timeoutMs} ms`);
    this.name = "TtsTimeoutError";
  }
}

/** The engine ran and answered, but with an error or with output that breaks the contract. */
export class TtsFailedError extends TtsError {
  constructor(providerId: string, message: string, options?: { cause?: unknown }) {
    super("failed", providerId, message, options);
    this.name = "TtsFailedError";
  }
}
