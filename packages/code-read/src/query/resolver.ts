import { EXIT, errorEnvelope, successEnvelope, type JsonEnvelope } from "@titan-design/rpc-protocol";
import type { z } from "zod";
import { QUERIES, type QueryFn } from "./commands.js";
import { CONTRACT, type CommandName } from "./contract.js";
import type { ReadSource } from "./source.js";

/** rpc-client's static `resolve` option: raw args in, an envelope out, never a throw. */
export type QueryResolver = (name: string, args: unknown) => JsonEnvelope<unknown>;

function isCommandName(name: string): name is CommandName {
  return Object.hasOwn(CONTRACT, name);
}

// Same wording as the registry's invokeCommand, so a static answer reads like a live one.
function formatIssues(error: z.ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
}

function describeFailure(err: unknown): { message: string; code: number } {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return { message, code: typeof code === "number" ? code : EXIT.GENERIC };
}

/** Validate, run, and envelope one command against a source, exactly as the daemon's registry does. */
export function createQueryResolver(source: ReadSource): QueryResolver {
  return (name, rawArgs) => {
    if (!isCommandName(name)) return errorEnvelope(`Unknown command: ${name}`, EXIT.USAGE);
    if (!source.facts().commands.includes(name)) {
      return errorEnvelope(`${name} is not available from a ${source.facts().dataset} dataset`, EXIT.UNAVAILABLE);
    }
    const parsed = CONTRACT[name].args.safeParse(rawArgs ?? {});
    if (!parsed.success) return errorEnvelope(`Invalid arguments: ${formatIssues(parsed.error)}`, EXIT.DATAERR);
    try {
      const query = QUERIES[name] as QueryFn<CommandName>;
      return successEnvelope(query(source, parsed.data as never));
    } catch (err) {
      const { message, code } = describeFailure(err);
      return errorEnvelope(message, code);
    }
  };
}
