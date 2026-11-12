import { readFileSync } from 'node:fs';
import { InvalidArgumentError } from 'commander';

/** An `@<file>` value of an array flag stands for the file's non-blank lines, trimmed; any other value is itself. */
export function expandFileValue(flag: string, value: string): string[] {
  if (!value.startsWith('@')) return [value];
  const file = value.slice(1);
  const lines = readText(flag, file)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) throw new InvalidArgumentError(`${flag} @${file}: the file has no values`);
  return lines;
}

function readText(flag: string, file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new InvalidArgumentError(`${flag} @${file}: cannot read it (${errorCode(error)})`);
  }
}

function errorCode(error: unknown): string {
  return error instanceof Error && 'code' in error ? String(error.code) : String(error);
}
