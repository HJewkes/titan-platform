export const FULL_SHA = /^[0-9a-f]{40}$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && FULL_SHA.test(value);
}
