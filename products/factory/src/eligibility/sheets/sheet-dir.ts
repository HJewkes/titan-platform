import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseBetSheet, type BetSheetResult } from "./bet-sheet.js";

export interface SheetFile {
  file: string;
  result: BetSheetResult;
}

/** Digests sit beside the sheets by default: `<sheetDir>/../digests`. */
export const defaultDigestDir = (sheetDir: string): string => join(dirname(sheetDir), "digests");

/** Every `*.md` sheet directly in `sheetDir`, by name; subdirectories (the prose record) are not sheets. Throws when the dir is unreadable. */
export function readSheetDir(sheetDir: string, digestDir = defaultDigestDir(sheetDir)): SheetFile[] {
  const digestText = (name: string): string | undefined => {
    const path = join(digestDir, `${name}.md`);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  return readdirSync(sheetDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({ file, result: parseBetSheet(readFileSync(join(sheetDir, file), "utf8"), digestText) }));
}
