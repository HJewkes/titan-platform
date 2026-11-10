const TSCONFIG_NAME = /^tsconfig\.(typecheck|test|tests)\.json$/;
const TEST_ENTRY = /\.test\.ts$/;
const LIST_KEYS: ReadonlySet<string> = new Set(["include", "exclude"]);

/** Whether `path` names a test-support tsconfig (typecheck or test); a build tsconfig.json is source. */
export const isTsconfigPath = (path: string): boolean => TSCONFIG_NAME.test(path.slice(path.lastIndexOf("/") + 1));

/** Characters tsc treats as line ends but JSON does not, so a text holding one is never read here. */
const LINE_BREAKS = /[\r\u2028\u2029]/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Keys of every object in source order, read from the raw text; JSON.parse alone would hide a repeat. */
function repeatsKey(text: string): boolean {
  const scopes: Array<Set<string> | null> = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === '"') {
      let end = index + 1;
      while (text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      const isKey = text.slice(end + 1).trimStart().startsWith(":");
      const scope = scopes[scopes.length - 1];
      if (isKey && scope) {
        const key = text.slice(index, end + 1);
        if (scope.has(key)) return true;
        scope.add(key);
      }
      index = end + 1;
      continue;
    }
    if (char === "{") scopes.push(new Set());
    else if (char === "[") scopes.push(null);
    else if (char === "}" || char === "]") scopes.pop();
    index += 1;
  }
  return false;
}

/**
 * Fails closed instead of imitating tsc's JSONC reader: comments, trailing commas, odd line breaks and repeated keys all read
 * as unparseable, so the file stays source. Only text that strict JSON and tsc cannot disagree about is compared.
 */
function parseTsconfig(text: string): Record<string, unknown> | undefined {
  if (LINE_BREAKS.test(text)) return undefined;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) && !repeatsKey(text) ? value : undefined;
  } catch {
    return undefined;
  }
}

const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");
const stringList = (value: unknown): string[] | undefined => (isStringList(value) ? value : undefined);

/** The entries two lists differ by, as a multiset difference; undefined unless both are string lists, since a list that appears or vanishes changes what the default covers. */
function changedEntries(before: unknown, after: unknown): string[] | undefined {
  const left = stringList(before);
  const right = stringList(after);
  if (left === undefined || right === undefined) return undefined;
  const remaining = [...right];
  const changed: string[] = [];
  for (const entry of left) {
    const at = remaining.indexOf(entry);
    if (at === -1) changed.push(entry);
    else remaining.splice(at, 1);
  }
  return [...changed, ...remaining];
}

/**
 * TP-5200: true only when two versions of a tsconfig differ solely by `*.test.ts` entries added to or removed from `include` or
 * `exclude`. Any other difference, an unparseable side or a list that is not strings reads false, so the file stays source.
 */
export function onlyTestEntriesChanged(beforeText: string, afterText: string): boolean {
  const before = parseTsconfig(beforeText);
  const after = parseTsconfig(afterText);
  if (before === undefined || after === undefined) return false;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  let changedAny = false;
  for (const key of keys) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue;
    if (!LIST_KEYS.has(key)) return false;
    const changed = changedEntries(before[key], after[key]);
    if (changed === undefined || changed.length === 0 || !changed.every((entry) => TEST_ENTRY.test(entry))) return false;
    changedAny = true;
  }
  return changedAny;
}
