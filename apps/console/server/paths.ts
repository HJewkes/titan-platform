import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** apps/console: one level up from both server/ (run by tsx) and dist/ (the built bin). */
export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The single-file build `mountStaticApp` serves. */
export const PAGE_FILE = path.join(APP_DIR, "dist", "index.html");

/** The same page with a snapshot embedded, written by `export`. */
export const EXPORT_FILE = path.join(APP_DIR, "dist", "console.html");

export const APP_VERSION = (JSON.parse(readFileSync(path.join(APP_DIR, "package.json"), "utf8")) as { version: string }).version;
