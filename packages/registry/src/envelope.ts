import { EXIT } from "@titan-design/rpc-protocol";

// The wire shapes live in rpc-protocol so browser clients can import them without zod.
export type { JsonEnvelope } from "@titan-design/rpc-protocol";
export { EXIT, errorEnvelope, successEnvelope } from "@titan-design/rpc-protocol";

export interface ErrorDescription {
  message: string;
  code: number;
}

/** Read a thrown value's message and numeric `code`, falling back to EXIT.GENERIC. */
export function describeError(err: unknown): ErrorDescription {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { message: err.message, code: typeof code === "number" ? code : EXIT.GENERIC };
  }
  return { message: String(err), code: EXIT.GENERIC };
}
