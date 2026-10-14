export type TtsErrorCode = "unavailable" | "unsupported" | "timeout" | "failed" | "misconfigured" | "unknown-kind";

/** A provider that selection passed over, and why. */
export interface SkippedProvider {
  id: string;
  reason: string;
  /** Set when the provider was skipped for lacking capabilities. */
  missing?: readonly string[];
  /** Set when the provider's own config is wrong, as opposed to its engine being absent. */
  misconfigured?: true;
}

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

/**
 * Selection reached a provider whose config is wrong. `misconfigured`: a bad entry or a secret that resolves to
 * nothing, without `tts.fallback: true`. `unknown-kind`: a `kind` no factory is registered for, which never falls
 * back, because a typo would otherwise hand the text to the next engine, possibly a remote one.
 */
export class TtsConfigError extends TtsError {
  constructor(
    providerId: string,
    message: string,
    readonly skipped: readonly SkippedProvider[],
    code: "misconfigured" | "unknown-kind" = "misconfigured",
  ) {
    super(code, providerId, message);
    this.name = "TtsConfigError";
  }
}

/** The engine ran and answered, but with an error or with output that breaks the contract. */
export class TtsFailedError extends TtsError {
  constructor(providerId: string, message: string, options?: { cause?: unknown }) {
    super("failed", providerId, message, options);
    this.name = "TtsFailedError";
  }
}
