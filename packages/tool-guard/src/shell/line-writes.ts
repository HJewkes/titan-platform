type VarsMap = Map<string, string | null>;

/**
 * One line's writes to each name, wherever on the line each sits, over those of the line that ran it: math reads a name
 * in a loop or a function body after a write that comes later in the text. Never changed once made.
 */
interface WriteTable {
  own: ReadonlyMap<string, string | null>;
  outer: WriteTable | undefined;
}

/**
 * Marks a scope that holds a table. Scopes copy it with their values, so a copy made without `copyVars` reads every
 * name as unknown rather than as one the line never wrote.
 */
const HAS_TABLE = "wrote@table";
/** Separates the texts of a name's writes: each is read on its own. */
export const VALUE_SEPARATOR = "\0";

/**
 * Held beside each scope's variables, not in them: a scope is copied per subshell and per nested walk, and a key per
 * written name made each copy cost as much as the line had names.
 */
const tables = new WeakMap<ReadonlyMap<string, string | null>, WriteTable>();

/** Adds a token list's writes, each name's texts joined and null when one is unknown, over those the scope has. */
export function addLineWrites(vars: VarsMap, own: ReadonlyMap<string, string | null>): void {
  const outer = tables.get(vars);
  if (own.size === 0 || (outer === undefined && vars.has(HAS_TABLE))) return;
  tables.set(vars, { own, outer });
  vars.set(HAS_TABLE, "");
}

/** The texts the line wrote to NAME, joined by `VALUE_SEPARATOR`; null when one is unknown, undefined when none. */
export function writtenText(vars: ReadonlyMap<string, string | null>, name: string): string | null | undefined {
  const table = tables.get(vars);
  if (table === undefined) return vars.has(HAS_TABLE) ? null : undefined;
  const texts: string[] = [];
  for (let t: WriteTable | undefined = table; t !== undefined; t = t.outer) {
    const text = t.own.get(name);
    if (text === null) return null;
    if (text !== undefined) texts.push(text);
  }
  return texts.length === 0 ? undefined : texts.join(VALUE_SEPARATOR);
}

/** A copy of a scope's variables that shares its write table, which no scope changes once made. */
export function copyVars(vars: VarsMap): VarsMap {
  const copy: VarsMap = new Map(vars);
  const table = tables.get(vars);
  if (table !== undefined) tables.set(copy, table);
  return copy;
}
