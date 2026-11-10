const TSCONFIG_NAME = /^tsconfig(\.[^/]*)?\.json$/;
const TEST_ENTRY = /\.test\.ts$/;
const LIST_KEYS: ReadonlySet<string> = new Set(["include", "exclude"]);

/** Whether `path` names a tsconfig*.json, wherever it sits. */
export const isTsconfigPath = (path: string): boolean => TSCONFIG_NAME.test(path.slice(path.lastIndexOf("/") + 1));

/** Removes comments and trailing commas outside strings, as tsc reads a tsconfig. */
function stripJsonc(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    const next = text[index + 1];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function parseTsconfig(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(stripJsonc(text));
    return isRecord(value) ? value : undefined;
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
