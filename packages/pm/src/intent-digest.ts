import { OwnerIntentRefSchema } from "./planning.js";

export const INTENT_DIGEST_SCHEMA = "titan-intent-digest/v1";

export const INTENT_SECTIONS = [
  "Standing direction",
  "Reasons",
  "Ruled out",
  "Taste",
  "Open questions",
  "Superseded",
] as const;

export type IntentSection = (typeof INTENT_SECTIONS)[number];

export interface IntentLine {
  /** `<slug>/I<n>`, the owner-intent id other records cite. */
  id: string;
  date: string;
  quote: string;
  /** The reference to the exact quote, for example `msg:3f2a91`. */
  ref: string;
  section: IntentSection;
  supersededBy?: string;
}

export interface IntentDigestError {
  line: number;
  message: string;
}

export type IntentDigestResult =
  | { ok: true; slug: string; initiative: string; builtFrom: string; lines: IntentLine[] }
  | { ok: false; errors: IntentDigestError[] };

// Greedy quote group: a quote may hold double quotes, so it ends at the last `" (quote:` on the line.
const BULLET = /^- I(\d+) (\S+) "(.*)" \(quote: (\S+)\)(?: superseded-by: I(\d+))?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FRONT_KEYS = ["schema", "slug", "initiative", "built_from"] as const;

const isRealDate = (value: string): boolean =>
  ISO_DATE.test(value) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

function whyBulletFails(raw: string): string {
  if (!/^- I\d+ /.test(raw)) return "bullet must start with `- I<n> `";
  const afterId = raw.replace(/^- I\d+ /, "");
  const date = afterId.split(" ")[0] ?? "";
  if (!isRealDate(date)) return `date must be a real YYYY-MM-DD, got "${date}"`;
  if (!/^\S+ ".*"/.test(afterId)) return "bullet has no quote in double quotes";
  if (!/\(quote: \S+\)/.test(afterId)) return "bullet has no `(quote: <ref>)` reference";
  return 'bullet must read `- I<n> <date> "<quote>" (quote: <ref>)[ superseded-by: I<m>]`';
}

function parseFrontMatter(rows: string[], errors: IntentDigestError[]): { values: Record<string, string>; next: number } {
  const values: Record<string, string> = {};
  if (rows[0]?.trim() !== "---") {
    errors.push({ line: 1, message: "digest must open with a `---` front matter block" });
    return { values, next: 0 };
  }
  let i = 1;
  for (; i < rows.length && rows[i]!.trim() !== "---"; i++) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(rows[i]!);
    if (match) values[match[1]!] = match[2]!.trim();
    else errors.push({ line: i + 1, message: "front matter line must be `key: value`" });
  }
  if (i >= rows.length) errors.push({ line: rows.length, message: "front matter block is never closed" });
  for (const key of FRONT_KEYS) if (!values[key]) errors.push({ line: 1, message: `front matter is missing ${key}` });
  if (values.schema && values.schema !== INTENT_DIGEST_SCHEMA) {
    errors.push({ line: 2, message: `schema must be ${INTENT_DIGEST_SCHEMA}, got ${values.schema}` });
  }
  return { values, next: i + 1 };
}

function parseBullet(raw: string, number: number, slug: string, section: IntentSection, errors: IntentDigestError[]) {
  const match = BULLET.exec(raw);
  if (!match) return void errors.push({ line: number, message: whyBulletFails(raw) });
  const [, n, date, quote, ref, superseded] = match as unknown as [string, string, string, string, string, string?];
  const id = `${slug}/I${n}`;
  const problems: string[] = [];
  if (!isRealDate(date)) problems.push(`date must be a real YYYY-MM-DD, got "${date}"`);
  if (quote.length === 0) problems.push("quote is empty");
  const refCheck = OwnerIntentRefSchema.safeParse({ intent_ref: id, quote_ref: ref });
  if (!refCheck.success) problems.push(...refCheck.error.issues.map((issue) => issue.message));
  for (const message of problems) errors.push({ line: number, message });
  if (problems.length > 0) return undefined;
  const line: IntentLine = { id, date, quote, ref, section };
  if (superseded !== undefined) line.supersededBy = `${slug}/I${superseded}`;
  return line;
}

interface Located {
  entry: IntentLine;
  number: number;
}

function parseBody(rows: string[], from: number, slug: string, errors: IntentDigestError[]): Located[] {
  const entries: Located[] = [];
  const seenSections = new Set<string>();
  let section: IntentSection | undefined;
  for (let i = from; i < rows.length; i++) {
    const raw = rows[i]!;
    if (raw.trim() === "") continue;
    const heading = /^## (.*)$/.exec(raw);
    if (heading) {
      const name = heading[1]!.trim();
      section = (INTENT_SECTIONS as readonly string[]).includes(name) ? (name as IntentSection) : undefined;
      if (!section) errors.push({ line: i + 1, message: `unknown section "${name}"` });
      else if (seenSections.has(name)) errors.push({ line: i + 1, message: `duplicate section "${name}"` });
      seenSections.add(name);
    } else if (section) {
      const parsed = parseBullet(raw, i + 1, slug, section, errors);
      if (parsed) entries.push({ entry: parsed, number: i + 1 });
    } else errors.push({ line: i + 1, message: "content outside a known section" });
  }
  for (const name of INTENT_SECTIONS) {
    if (!seenSections.has(name)) errors.push({ line: rows.length, message: `missing section "${name}"` });
  }
  return entries;
}

function checkReferences(entries: Located[], errors: IntentDigestError[]): void {
  const ids = new Set<string>();
  for (const { entry, number } of entries) {
    if (ids.has(entry.id)) errors.push({ line: number, message: `duplicate id ${entry.id}` });
    ids.add(entry.id);
  }
  for (const { entry, number } of entries) {
    if (entry.supersededBy !== undefined && !ids.has(entry.supersededBy)) {
      errors.push({ line: number, message: `superseded-by names ${entry.supersededBy}, which is not in the file` });
    }
  }
}

/** Parses a `titan-intent-digest/v1` file. Strict: any malformed bullet fails the whole digest, never a partial read. */
export function parseIntentDigest(text: string): IntentDigestResult {
  const errors: IntentDigestError[] = [];
  const rows = text.split(/\r?\n/);
  const { values, next } = parseFrontMatter(rows, errors);
  const entries = parseBody(rows, next, values.slug ?? "", errors);
  checkReferences(entries, errors);
  if (errors.length > 0) return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  return { ok: true, slug: values.slug!, initiative: values.initiative!, builtFrom: values.built_from!, lines: entries.map(({ entry }) => entry) };
}
