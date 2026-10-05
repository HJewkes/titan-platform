const ERROR_CLASS_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** Only the error's class name, so a reason that reaches a public PR comment carries nothing from the error's text. */
export function errorClass(error: unknown): string {
  try {
    if (!(error instanceof Error)) return "non-Error";
    const name: unknown = error.name;
    return typeof name === "string" && ERROR_CLASS_NAME.test(name) ? name : "Error";
  } catch {
    return "Error";
  }
}

/** The HTTP status when the error carries a numeric one, otherwise its class name; never any of its text. */
export function failureOf(error: unknown): string {
  try {
    const status: unknown = (error as { status?: unknown } | null)?.status;
    if (typeof status === "number" && Number.isInteger(status)) return `HTTP ${status}`;
  } catch {
    return errorClass(error);
  }
  return errorClass(error);
}
