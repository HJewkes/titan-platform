import { promises as fs } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ValidationError } from '../errors.js';

/*
 * The owner-message extract: one JSON row per message the owner typed, the raw record intent lines quote from. It
 * lives in the factory plan folder (TP-5453 P9); the first extracts were written to a sources folder, which stays
 * readable until every extract has been imported.
 */

/** The fields intent lines rely on; the extractor's other fields ride along untouched. */
export const OwnerMessageSchema = z.looseObject({
  id: z.string().regex(/^[A-Za-z0-9][\w.-]*$/, { message: 'message id must be a single token' }),
  ts: z.string().regex(/^\d{4}-\d{2}-\d{2}/, { message: 'ts must start with a YYYY-MM-DD date' }),
  text: z.string(),
});

export type OwnerMessage = z.infer<typeof OwnerMessageSchema>;

export function ownerMessagesPath(activeRoot: string): string {
  return path.join(activeRoot, 'factory', 'plan', 'owner-messages.jsonl');
}

export function legacyOwnerMessagesPath(activeRoot: string): string {
  return path.join(activeRoot, 'titan-platform', 'sources', 'owner-intent', 'owner-messages.jsonl');
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return null;
    throw err;
  }
}

function parseRow(row: string, where: string): OwnerMessage {
  let json: unknown;
  try {
    json = JSON.parse(row);
  } catch {
    throw new ValidationError(`${where}: not a JSON row`);
  }
  const parsed = OwnerMessageSchema.safeParse(json);
  if (!parsed.success) throw new ValidationError(`${where}: ${parsed.error.issues[0]?.message ?? 'invalid row'}`);
  return parsed.data;
}

function parseRows(raw: string, file: string): OwnerMessage[] {
  return raw
    .split('\n')
    .map((row, index) => ({ row, line: index + 1 }))
    .filter(({ row }) => row.trim() !== '')
    .map(({ row, line }) => parseRow(row, `${file} line ${line}`));
}

/** Rows of one extract file; a missing file holds none. */
export async function readOwnerMessageFile(file: string): Promise<OwnerMessage[]> {
  const raw = await readIfPresent(file);
  return raw === null ? [] : parseRows(raw, file);
}

/** The extract at its factory path, or the old sources copy while the factory file does not exist yet. */
export async function readOwnerMessages(activeRoot: string): Promise<OwnerMessage[]> {
  const current = await readIfPresent(ownerMessagesPath(activeRoot));
  if (current !== null) return parseRows(current, ownerMessagesPath(activeRoot));
  return readOwnerMessageFile(legacyOwnerMessagesPath(activeRoot));
}

/** Appends the rows whose ids the factory extract lacks; the file is append-only, so nothing already there changes. */
export async function appendOwnerMessages(activeRoot: string, rows: readonly OwnerMessage[]): Promise<{ added: number; total: number }> {
  const file = ownerMessagesPath(activeRoot);
  const existing = await readOwnerMessageFile(file);
  const seen = new Set(existing.map((row) => row.id));
  const fresh = rows.filter((row) => !seen.has(row.id) && seen.add(row.id));
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (fresh.length > 0) await fs.appendFile(file, fresh.map((row) => `${JSON.stringify(row)}\n`).join(''));
  return { added: fresh.length, total: existing.length + fresh.length };
}
