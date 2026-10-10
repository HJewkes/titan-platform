import { formatSquashMessage, type SquashCommit, type SquashInput } from "./squash-message.js";

interface SquashCliIo {
  readStdin(): string;
  out(text: string): void;
  err(line: string): void;
}

const USAGE = [
  "usage: titan-squash-message [--json] < input.json",
  "  input: { title, body, prNumber, taskIds: string[], commits: [{ subject, body }] }",
  "  prints the subject, a blank line and the body; --json prints { subject, body }",
  "exit: 0 formatted, 2 usage or input error",
];

const PREFIX = "titan-squash-message: ";

class SquashInputError extends Error {}

export function runSquashCli(args: readonly string[], io: SquashCliIo): number {
  const json = args.length === 1 && args[0] === "--json";
  if (args.length > 0 && !json) {
    for (const line of USAGE) io.err(line);
    return 2;
  }
  try {
    const message = formatSquashMessage(parseInput(parseJson(io.readStdin())));
    io.out(json ? `${JSON.stringify(message)}\n` : `${message.subject}\n\n${message.body}\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof SquashInputError)) throw error;
    io.err(PREFIX + error.message);
    return 2;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SquashInputError("stdin is not valid JSON");
  }
}

function parseInput(value: unknown): SquashInput {
  const record = asRecord(value, "input");
  const prNumber = record["prNumber"];
  if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber < 1) {
    throw new SquashInputError("prNumber must be a positive integer");
  }
  return {
    title: asString(record["title"], "title"),
    body: asOptionalString(record["body"], "body"),
    prNumber,
    taskIds: asArray(record["taskIds"], "taskIds").map((id, i) => asString(id, `taskIds[${i}]`)),
    commits: asArray(record["commits"], "commits").map(parseCommit),
  };
}

function parseCommit(value: unknown, index: number): SquashCommit {
  const record = asRecord(value, `commits[${index}]`);
  return {
    subject: asString(record["subject"], `commits[${index}].subject`),
    body: asOptionalString(record["body"], `commits[${index}].body`),
  };
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SquashInputError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new SquashInputError(`${field} must be an array`);
  return value;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new SquashInputError(`${field} must be a string`);
  return value;
}

/** GitHub reports an empty PR body as null. */
function asOptionalString(value: unknown, field: string): string {
  return value === null || value === undefined ? "" : asString(value, field);
}
