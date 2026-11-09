import { promises as fs } from 'node:fs';
import YAML from 'yaml';
import type { ZodType } from 'zod';

const FRONTMATTER_DELIM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Read a markdown file with YAML frontmatter and validate the frontmatter
 * against `schema`.
 *
 * We parse the YAML block using the `yaml` package (eemeli/yaml) rather than
 * relying on gray-matter, because gray-matter's js-yaml backend converts
 * bare YAML dates (e.g. `updated: 2026-05-10`) into JavaScript `Date`
 * instances. Our schemas validate `YYYY-MM-DD` strings, so we want the raw
 * lexical form preserved.
 */
export async function readMarkdownWithSchema<T>(
  filePath: string,
  schema: ZodType<T>,
): Promise<{ frontmatter: T; body: string }> {
  const raw = await fs.readFile(filePath, 'utf8');
  const match = FRONTMATTER_DELIM.exec(raw);
  let frontmatterText = '';
  let body = raw;
  if (match) {
    frontmatterText = match[1];
    body = match[2];
  }
  const parsed = frontmatterText ? YAML.parse(frontmatterText) : {};
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Frontmatter validation failed for ${filePath}: ${result.error.message}`);
  }
  return { frontmatter: result.data, body };
}
