/** The path is gone, or one of its parent components is now a file. Every other I/O error is real. */
export function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * A locator whose line is gone: the file was removed or truncated, or the bytes at
 * the span were rewritten so they no longer decode as UTF-8 or parse as JSON.
 */
export function isStaleLine(error: unknown): boolean {
  if (isMissing(error) || error instanceof SyntaxError) return true;
  if (errorCode(error) === "ERR_ENCODING_INVALID_ENCODED_DATA") return true;
  // readLocatorBytes reports a span past the end of a shorter file only through its message.
  return error instanceof Error && error.message.includes("runs past the end");
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? (error as { code?: unknown }).code : undefined;
}
