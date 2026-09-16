/**
 * A YAML subset, deliberately, rather than a YAML dependency.
 *
 * The harness reads exactly three things out of a session record — `session_id`,
 * `track`, and the `text` of each `next_steps` entry — and active-work writes
 * them in one shape: top-level scalars, and a list of maps whose long values
 * are folded or literal block scalars. That is small enough to parse honestly
 * and test, and it keeps a product that only ever reads files from taking a
 * parser dependency it would then have to keep current.
 *
 * It does NOT handle flow collections, anchors, multi-document files, or
 * nested lists. Anything it cannot read comes back undefined or absent, never
 * wrong-but-plausible.
 */

const FENCE = "---";

/** The frontmatter block's raw text, or undefined when the file has none. */
export function readFrontmatter(markdown: string): string | undefined {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== FENCE) return undefined;
  const end = lines.indexOf(FENCE, 1);
  return end === -1 ? undefined : lines.slice(1, end).join("\n");
}

function unquote(value: string): string {
  const trimmed = value.trim();
  const quoted = /^(['"])([\s\S]*)\1$/.exec(trimmed);
  return quoted ? quoted[2]! : trimmed;
}

/** A top-level `key: value` scalar. Block scalars at top level are not read. */
export function scalarField(frontmatter: string, key: string): string | undefined {
  for (const line of frontmatter.split("\n")) {
    const match = new RegExp(`^${key}:\\s*(.*)$`).exec(line);
    if (match) {
      const value = unquote(match[1] ?? "");
      return value.length > 0 ? value : undefined;
    }
  }
  return undefined;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Lines belonging to a top-level block, i.e. indented past column zero. */
function blockUnder(lines: string[], key: string): string[] {
  const start = lines.findIndex((line) => line.trimEnd() === `${key}:`);
  if (start === -1) return [];
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length > 0 && indentOf(line) === 0) break;
    body.push(line);
  }
  return body;
}

/** Split a list body into one chunk per `- ` item, each with its continuation lines. */
function chunkItems(body: string[]): string[][] {
  const chunks: string[][] = [];
  for (const line of body) {
    if (/^\s*-\s/.test(line)) chunks.push([line]);
    else if (chunks.length > 0) chunks[chunks.length - 1]!.push(line);
  }
  return chunks;
}

/**
 * A top-level list of maps, as flat string fields.
 *
 * Block scalars are folded to a single line whichever marker they use: the
 * caller wants query text, and the difference between `>` and `|` is layout.
 */
export function listOfMaps(frontmatter: string, key: string): Record<string, string>[] {
  return chunkItems(blockUnder(frontmatter.split("\n"), key)).map(itemFields);
}

interface OpenBlock {
  key: string;
  /** Column the opening `key:` sat at; its body must be indented past this. */
  indent: number;
  lines: string[];
}

/**
 * Inside an open block scalar, a line that merely contains a colon is prose.
 *
 * Without this, a loop whose text reads `Cause: the reader state` would be read
 * as a new field named `Cause` and truncate the loop mid-sentence. Indentation
 * is what tells them apart: a block's body is indented past its own key, while
 * the item's next field returns to the key's own column.
 */
function continuesBlock(block: OpenBlock | undefined, line: string): boolean {
  return block !== undefined && indentOf(line) > block.indent;
}

function itemFields(chunk: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  const normalised = chunk.map((line, i) => (i === 0 ? line.replace(/^(\s*)-\s/, "$1  ") : line));
  let block: OpenBlock | undefined;
  const close = () => {
    if (block) fields[block.key] = block.lines.join(" ").trim();
    block = undefined;
  };
  for (const line of normalised) {
    if (continuesBlock(block, line)) {
      if (line.trim().length > 0) block!.lines.push(line.trim());
      continue;
    }
    const match = /^(\s*)([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    close();
    const [, indent, name, value] = match;
    if (/^[|>][-+]?$/.test(value!.trim())) block = { key: name!, indent: indent!.length, lines: [] };
    else fields[name!] = unquote(value!);
  }
  close();
  return fields;
}
