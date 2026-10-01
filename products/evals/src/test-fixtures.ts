import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The synthetic `summarize-note` unit shipped under fixtures/. */
export const FIXTURE_ROOT = fileURLToPath(new URL("../fixtures/summarize-note/", import.meta.url));

export function readFixture<T = unknown>(relative: string): T {
  return JSON.parse(readFileSync(`${FIXTURE_ROOT}${relative}`, "utf8")) as T;
}
