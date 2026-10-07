import { parseArgs } from "node:util";
import { lintMorningList, lintOwnerQuestions, type AskItemFindings } from "./ask-lint.js";

interface AskLintIo {
  readFile(path: string): string;
  out(line: string): void;
  err(line: string): void;
}

const USAGE = "usage: ask-lint <file> [--section <heading>] [--json] [--strict]";
const PREFIX = "ask-lint: ";

class UsageError extends Error {}

interface Options {
  file: string;
  section?: string;
  json: boolean;
  strict: boolean;
}

function parseOptions(argv: readonly string[]): Options {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { section: { type: "string" }, json: { type: "boolean" }, strict: { type: "boolean" } },
    });
  } catch {
    throw new UsageError("unknown option or missing option value");
  }
  const { positionals, values } = parsed;
  if (positionals.length !== 1) throw new UsageError("expected exactly one file");
  return { file: positionals[0] ?? "", section: values.section, json: values.json ?? false, strict: values.strict ?? false };
}

function readInput(file: string, io: AskLintIo): string {
  try {
    return io.readFile(file);
  } catch {
    throw new UsageError(`cannot read ${file}`);
  }
}

/** The lines under the first heading whose text is `heading`, up to the next heading of its level or higher. */
function sectionBody(text: string, heading: string): string[] | null {
  const want = heading.trim().toLowerCase();
  let level = 0;
  let body: string[] | null = null;
  for (const line of text.split("\n")) {
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const depth = match?.[1]?.length ?? 0;
    if (body && match && depth <= level) break;
    if (body) body.push(line);
    else if (match && (match[2] ?? "").toLowerCase() === want) [level, body] = [depth, []];
  }
  return body;
}

/** lintOwnerQuestions reads "Owner questions" headings, so the chosen section is re-headed as one. */
function lintSection(text: string, heading: string): AskItemFindings[] {
  const body = sectionBody(text, heading);
  if (!body) throw new UsageError(`no section headed "${heading}"`);
  return lintOwnerQuestions(["# Owner questions", ...body].join("\n"));
}

function report(items: readonly AskItemFindings[], json: boolean, io: AskLintIo): number {
  let count = 0;
  for (const { id, findings } of items) {
    for (const { rule, evidence } of findings) {
      io.out(json ? JSON.stringify({ id, rule, evidence }) : `${id} ${rule} ${evidence}`);
      count += 1;
    }
  }
  return count;
}

/** Exit 0 by default, 1 under --strict when any finding exists, 2 on a usage, file or section error. */
export function runAskLint(argv: readonly string[], io: AskLintIo): number {
  try {
    const options = parseOptions(argv);
    const text = readInput(options.file, io);
    const items = options.section === undefined ? lintMorningList(text) : lintSection(text, options.section);
    const count = report(items, options.json, io);
    return options.strict && count > 0 ? 1 : 0;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.err(`${PREFIX}${error.message}; ${USAGE}`);
    return 2;
  }
}
