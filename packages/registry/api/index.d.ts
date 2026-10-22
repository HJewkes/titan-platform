import { ZodType, core } from 'zod';
import { JsonEnvelope } from '@titan-design/rpc-protocol';
export { EXIT, JsonEnvelope, errorEnvelope, successEnvelope } from '@titan-design/rpc-protocol';

/** The context every command receives. Products extend it with their own fields. */
interface BaseContext {
    warnings: string[];
    format: "human" | "json";
}
interface CliOption {
    long: string;
    short?: string;
    description: string;
    required?: boolean;
    /** Placeholder label for a value-taking flag; booleans remain bare. */
    valueName?: string;
}
interface CliMeta {
    positional?: string[];
    options?: Record<string, CliOption>;
    usage?: string;
}
interface Command<Args = unknown, Result = unknown, Ctx extends BaseContext = BaseContext> {
    name: string;
    description: string;
    args: ZodType<Args>;
    result: ZodType<Result>;
    cli?: CliMeta;
    /**
     * A property, not a method: method parameters are bivariant, so a command whose `run` needs a
     * narrower context than `Ctx` would typecheck as a `Command<…, Ctx>` and run without its fields.
     */
    run: (args: Args, ctx: Ctx) => Promise<Result>;
}
/** `AnyCommand<never>` accepts a command of any context, for code that reads it but never calls `run`. */
type AnyCommand<Ctx extends BaseContext = BaseContext> = Command<any, any, Ctx>;
declare function defineCommand<Args, Result, Ctx extends BaseContext = BaseContext>(cmd: Command<Args, Result, Ctx>): Command<Args, Result, Ctx>;
/**
 * The `CommandMap` a typed client is generic over, derived from commands keyed by their
 * names. Type-only: browser code imports the result with `import type`, so neither zod
 * nor this package reaches its bundle. Keys are not checked against `name`, which
 * `defineCommand` widens to `string`.
 */
type CommandMapOf<T extends Record<string, AnyCommand<never>>> = {
    [K in keyof T & string]: T[K] extends Command<infer Args, infer Result, never> ? {
        args: Args;
        result: Result;
    } : never;
};

interface CommandRegistry<Ctx extends BaseContext = BaseContext> {
    register(cmd: AnyCommand<Ctx>): void;
    get(name: string): AnyCommand<Ctx> | undefined;
    has(name: string): boolean;
    /** Every command, sorted by name so help output and tool lists are stable. */
    list(): AnyCommand<Ctx>[];
    readonly size: number;
}
/** A registry is an instance, not a module singleton, so each product owns its own. */
declare function createRegistry<Ctx extends BaseContext = BaseContext>(): CommandRegistry<Ctx>;

interface ErrorDescription {
    message: string;
    code: number;
}
/** Read a thrown value's message and numeric `code`, falling back to EXIT.GENERIC. */
declare function describeError(err: unknown): ErrorDescription;

/** The zod 4 `def.type` discriminator of a schema, e.g. "string", "array", "enum". */
type SchemaKind = string;
/** Peel optional / nullable / default wrappers down to the schema that carries the kind. */
declare function unwrapSchema(schema: ZodType): ZodType;
/** Kind of the innermost schema, using zod 4's public `def` rather than `_zod` internals. */
declare function schemaKind(schema: ZodType | undefined): SchemaKind | undefined;
/** The per-field schema of a top-level `z.object`, or undefined when there is none. */
declare function fieldSchema(args: ZodType, name: string): ZodType | undefined;
/** Kind of an array field's element schema, unwrapping the array itself first; undefined for non-arrays. */
declare function arrayElementKind(schema: ZodType | undefined): SchemaKind | undefined;
/** True when the field may be omitted from input: `.optional()` or `.default()`. */
declare function isOptionalField(schema: ZodType | undefined): boolean;

/** `--ship-target` becomes `ship_target`, the snake_case key convention for args schemas. */
declare function flagToKey(long: string): string;
/** commander camelCases long flag names, dropping the leading `--`. */
declare function camelizeFlagKey(flagKey: string): string;
/**
 * Read one option out of commander's parsed opts.
 *
 * commander stores `--no-thing` as `thing === false` and never defines `noThing`,
 * so a `--no-*` flag must be read back off its stem. The paired value flag must
 * ignore that `false`, or `--no-notes` would reach `--notes` as a boolean.
 */
declare function readCommanderOption(opts: Record<string, unknown>, spec: string): unknown;
/**
 * Coerce a raw commander value to the type the schema implies. For an array field, `value` is
 * the list of raw strings a repeatable flag collected; each element is coerced by `elementKind`.
 */
declare function coerceCliValue(value: unknown, kind: SchemaKind | undefined, elementKind?: SchemaKind): unknown;
/**
 * Commander's parser argument for a field's option, or undefined for a plain single-value flag.
 * An array-typed field needs this so repeated occurrences of its flag accumulate instead of
 * each overwriting the last (commander's default behavior for a same-named option).
 */
declare function collectOptionParser(cmd: AnyCommand<never>, key: string): ((value: string, previous: string[] | undefined) => string[]) | undefined;
/** Assemble the raw args record from commander positionals and parsed opts, coerced per schema. */
declare function collectCliArgs(cmd: AnyCommand<never>, positionals: unknown[], opts: Record<string, unknown>): Record<string, unknown>;
/** Boolean fields and exact true switches are bare; other fields take a value. */
declare function optionFlagSpec(cmd: AnyCommand<never>, key: string, opt: CliOption): string;
/** commander argument display: `[name]` when the schema allows omission, else `<name>`. */
declare function positionalSpec(cmd: AnyCommand<never>, name: string): string;
/** `task.add` becomes `["task", "add"]`: the commander sub-command path. */
declare function commandPath(name: string): string[];
/** Explicit zod default for a command field, for the product's Commander option wiring. */
declare function optionDefault(cmd: AnyCommand<never>, key: string): unknown;

interface InvokeOptions {
    /** Envelope code for args that fail schema validation. CLIs use EXIT.USAGE, servers EXIT.DATAERR. */
    invalidArgsCode?: number;
    /** Product-specific validation wording; receives the issues without an added prefix. */
    formatInvalidArgs?: (issues: readonly core.$ZodIssue[]) => string;
    /** Map a thrown value to a message and code. Defaults to reading a numeric `code` property. */
    formatError?: (err: unknown) => ErrorDescription;
}
interface Invocation<T = unknown> {
    envelope: JsonEnvelope<T>;
    exitCode: number;
}
/** Validate args, run the command, and always return an envelope. Never throws. */
declare function invokeCommand<Ctx extends BaseContext>(cmd: AnyCommand<Ctx>, rawArgs: unknown, ctx: Ctx, options?: InvokeOptions): Promise<Invocation>;
type InProcessCall = (name: string, args: unknown) => Promise<JsonEnvelope<unknown>>;
/**
 * Call registry commands by name in process. An unknown name yields a USAGE envelope, never a throw.
 * The context is a thunk so each call gets its own `warnings` and one call's warnings never leak into the next.
 */
declare function inProcessCaller<Ctx extends BaseContext>(registry: CommandRegistry<Ctx>, context: () => Ctx, options?: InvokeOptions): InProcessCall;

/** The transport-agnostic MCP tool descriptor; the SDK's `Tool` is a superset. */
interface McpToolDescriptor {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}
interface ToolNaming {
    /** Prepended to every tool name so one MCP client can host several registries. */
    prefix: string;
}
/** `task.add` with prefix `active__` becomes `active__task__add`. */
declare function commandNameToToolName(commandName: string, naming: ToolNaming): string;
/** Inverse of commandNameToToolName; null when the tool does not carry this prefix. */
declare function toolNameToCommandName(toolName: string, naming: ToolNaming): string | null;
/** Optional zod projection controls; omitted io preserves the existing output schema. */
type ToolSchemaOptions = Pick<core.ToJSONSchemaParams, "io" | "override">;
/** Build an MCP tool descriptor from a command's zod args via zod 4's native JSON Schema export. */
declare function commandToTool(cmd: AnyCommand<never>, naming: ToolNaming, options?: ToolSchemaOptions): McpToolDescriptor;

export { type AnyCommand, type BaseContext, type CliMeta, type CliOption, type Command, type CommandMapOf, type CommandRegistry, type ErrorDescription, type InProcessCall, type Invocation, type InvokeOptions, type McpToolDescriptor, type SchemaKind, type ToolNaming, type ToolSchemaOptions, arrayElementKind, camelizeFlagKey, coerceCliValue, collectCliArgs, collectOptionParser, commandNameToToolName, commandPath, commandToTool, createRegistry, defineCommand, describeError, fieldSchema, flagToKey, inProcessCaller, invokeCommand, isOptionalField, optionDefault, optionFlagSpec, positionalSpec, readCommanderOption, schemaKind, toolNameToCommandName, unwrapSchema };
