/**
 * A pointer into a transcript: `[transcriptIndex, byteOffset, byteLength]`.
 * The index names a row in a transcript table; the offset and length address
 * exact bytes in that file. Never the text itself.
 */
export type Locator = readonly [transcriptIndex: number, byteOffset: number, byteLength: number];

export function isLocator(value: unknown): value is Locator {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const [index, offset, length] = value as unknown[];
  return isNonNegativeInt(index) && isNonNegativeInt(offset) && isNonNegativeInt(length) && length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** `t:offset:length`, the compact form for URLs, log lines, and CLI args. */
export function formatLocator([index, offset, length]: Locator): string {
  return `${index}:${offset}:${length}`;
}

export function parseLocator(text: string): Locator {
  const parts = text.split(":").map((p) => (p === "" ? NaN : Number(p)));
  if (!isLocator(parts)) throw new Error(`invalid locator: ${JSON.stringify(text)}`);
  return parts;
}
