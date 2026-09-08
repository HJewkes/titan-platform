export interface HealthPayload extends Record<string, unknown> {
  ok: true;
  version: string;
  pid: number;
  uptime_ms: number;
  port: number;
}

export interface HealthPayloadInput {
  port: number;
  version: string;
  /** `Date.now()` at daemon start; uptime is measured against it. */
  startedAt: number;
  /** Product state merged into the payload. Core fields win on a key collision. */
  extension?: Record<string, unknown>;
}

export function buildHealthPayload(input: HealthPayloadInput): HealthPayload {
  return {
    ...input.extension,
    ok: true,
    version: input.version,
    pid: process.pid,
    uptime_ms: Date.now() - input.startedAt,
    port: input.port,
  };
}
