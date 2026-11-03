import { errorCode } from "@titan-design/rpc-protocol/narrow";

/** The path is gone, or one of its parent components is now a file. Every other I/O error is real. */
export function isMissing(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The path's name is longer than the filesystem allows, so nothing can exist there. */
export function isNameTooLong(error: unknown): boolean {
  return errorCode(error) === "ENAMETOOLONG";
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

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
