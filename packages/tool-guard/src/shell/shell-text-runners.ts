/** Builtins that run shell text from a file or stdin, which no word on the line spells out. */
export const SOURCERS: ReadonlySet<string> = new Set(["source", "."]);
/** Commands whose operands are stored as code, run later by name. */
export const STORED_CODE: ReadonlySet<string> = new Set(["trap", "alias"]);
