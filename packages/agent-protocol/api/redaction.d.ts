declare const REDACTED = "[REDACTED]";
declare function redactSecrets(value: string): string;
declare function redactSecrets(value: Error): Error;

export { REDACTED, redactSecrets };
