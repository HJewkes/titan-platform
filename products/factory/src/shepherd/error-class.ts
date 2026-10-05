/** A name is set by whoever threw, so only an identifier-shaped one is echoed. */
const ERROR_CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** A GitHub token, a JWT head or a long hex run can still be identifier-shaped, so these never pass as a class name. */
const CREDENTIAL_SHAPE = /^(?:gh[pousr]_|github_pat_|eyJ)|[0-9A-Fa-f]{32,}/;

/** Only the error's class name, so a reason that reaches a public PR comment carries nothing from the error's text. */
export function errorClass(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "non-Error";
    const name: unknown = error.name;
    return typeof name === "string" && ERROR_CLASS_NAME.test(name) && !CREDENTIAL_SHAPE.test(name) ? name : "Error";
  } catch {
    // A hostile Proxy or getter can throw from the type check or the name read; none of it is echoed.
    return "Error";
  }
}

const isHttpStatus = (status: unknown): status is number => typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599;

/** The HTTP status when the error carries one, otherwise its class name; never any of its text. */
export function failureOf(error: unknown): string {
  try {
    const status: unknown = (error as { status?: unknown } | null)?.status;
    if (isHttpStatus(status)) return `HTTP ${status}`;
  } catch {
    return errorClass(error);
  }
  return errorClass(error);
}

/** The error's text for the local console only, never a stored reason; a throwing getter reads as its class instead of failing the caller. */
export function consoleTextOf(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return `(unreadable ${errorClass(error)})`;
  }
}
