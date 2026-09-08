import type { ZodError } from "zod";
import { EXIT, describeError, errorEnvelope, successEnvelope, type ErrorDescription, type JsonEnvelope } from "./envelope.js";
import type { AnyCommand, BaseContext } from "./types.js";

export interface InvokeOptions {
  /** Envelope code for args that fail schema validation. CLIs use EXIT.USAGE, servers EXIT.DATAERR. */
  invalidArgsCode?: number;
  /** Map a thrown value to a message and code. Defaults to reading a numeric `code` property. */
  formatError?: (err: unknown) => ErrorDescription;
}

export interface Invocation<T = unknown> {
  envelope: JsonEnvelope<T>;
  exitCode: number;
}

/** Validate args, run the command, and always return an envelope. Never throws. */
export async function invokeCommand<Ctx extends BaseContext>(
  cmd: AnyCommand<Ctx>,
  rawArgs: unknown,
  ctx: Ctx,
  options: InvokeOptions = {},
): Promise<Invocation> {
  const formatError = options.formatError ?? describeError;
  const invalidArgsCode = options.invalidArgsCode ?? EXIT.DATAERR;

  const parsed = cmd.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const message = `Invalid arguments: ${formatZodError(parsed.error)}`;
    return { envelope: errorEnvelope(message, invalidArgsCode), exitCode: invalidArgsCode };
  }

  try {
    const result: unknown = await cmd.run(parsed.data, ctx);
    return { envelope: successEnvelope(result, ctx.warnings), exitCode: EXIT.OK };
  } catch (err) {
    const { message, code } = formatError(err);
    return { envelope: errorEnvelope(message, code), exitCode: code };
  }
}

function formatZodError(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}
