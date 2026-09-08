import type { ZodType } from "zod";

/** The context every command receives. Products extend it with their own fields. */
export interface BaseContext {
  warnings: string[];
  format: "human" | "json";
}

export interface CliOption {
  long: string;
  short?: string;
  description: string;
  required?: boolean;
}

export interface CliMeta {
  positional?: string[];
  options?: Record<string, CliOption>;
  usage?: string;
}

export interface Command<Args = unknown, Result = unknown, Ctx extends BaseContext = BaseContext> {
  name: string;
  description: string;
  args: ZodType<Args>;
  result: ZodType<Result>;
  cli?: CliMeta;
  run(args: Args, ctx: Ctx): Promise<Result>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand<Ctx extends BaseContext = BaseContext> = Command<any, any, Ctx>;

export function defineCommand<Args, Result, Ctx extends BaseContext = BaseContext>(
  cmd: Command<Args, Result, Ctx>,
): Command<Args, Result, Ctx> {
  return cmd;
}
