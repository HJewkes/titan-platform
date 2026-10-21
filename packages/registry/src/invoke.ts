import type { ZodError, core } from "zod";
import {
  EXIT,
  describeError,
  errorEnvelope,
  successEnvelope,
  type ErrorDescription,
  type JsonEnvelope,
} from "./envelope.js";
import type { CommandRegistry } from "./registry.js";
import type { AnyCommand, BaseContext } from "./types.js";

export interface InvokeOptions {
  /** Envelope code for args that fail schema validation. CLIs use EXIT.USAGE, servers EXIT.DATAERR. */
  invalidArgsCode?: number;
  /** Product-specific validation wording; receives the issues without an added prefix. */
  formatInvalidArgs?: (issues: readonly core.$ZodIssue[]) => string;
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
  options: InvokeOptions = {}
): Promise<Invocation> {
  const formatError = options.formatError ?? describeError;

  const parsed = cmd.args.safeParse(rawArgs ?? {});
  if (!parsed.success) return invalidArguments(parsed.error, options);

  try {
    const result: unknown = await cmd.run(parsed.data, ctx);
    return {
      envelope: successEnvelope(result, ctx.warnings),
      exitCode: EXIT.OK,
    };
  } catch (err) {
    const { message, code } = formatError(err);
    return { envelope: errorEnvelope(message, code), exitCode: code };
  }
}

export type InProcessCall = (
  name: string,
  args: unknown
) => Promise<JsonEnvelope<unknown>>;

/**
 * Call registry commands by name in process. An unknown name yields a USAGE envelope, never a throw.
 * The context is a thunk so each call gets its own `warnings` and one call's warnings never leak into the next.
 */
export function inProcessCaller<Ctx extends BaseContext>(
  registry: CommandRegistry<Ctx>,
  context: () => Ctx,
  options?: InvokeOptions
): InProcessCall {
  return async (name, args) => {
    const cmd = registry.get(name);
    if (!cmd) return errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE);
    return (await invokeCommand(cmd, args, context(), options)).envelope;
  };
}

function formatZodError(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

function invalidArguments(error: ZodError, options: InvokeOptions): Invocation {
  const invalidArgsCode = options.invalidArgsCode ?? EXIT.DATAERR;
  try {
    const message = options.formatInvalidArgs
      ? options.formatInvalidArgs(error.issues)
      : `Invalid arguments: ${formatZodError(error)}`;
    return { envelope: errorEnvelope(message, invalidArgsCode), exitCode: invalidArgsCode };
  } catch (err) {
    const { message, code } = (options.formatError ?? describeError)(err);
    return { envelope: errorEnvelope(message, code), exitCode: code };
  }
}
