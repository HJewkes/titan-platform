import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");

/** Source parse, because the console may not import factory code and must not pull it in just for a test. */
function stringsInInitializer(file: string, declaration: RegExp): string[] {
  const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
  const initializer = declaration.exec(source)?.[1];
  if (initializer === undefined) throw new Error(`no SEAT_STEPS declaration found in ${file}`);
  return [...initializer.matchAll(/"([^"]+)"/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

it("the console SEAT_STEPS mirror equals Shepherd's seat steps", () => {
  const shepherd = stringsInInitializer("products/factory/src/shepherd/waiting.ts", /export const SEAT_STEPS[^=]*=\s*\[([^\]]*)\]/);
  const mirror = stringsInInitializer("apps/console/server/blockers.ts", /const SEAT_STEPS[^=]*=\s*new Set\(\[([^\]]*)\]\)/);

  expect(shepherd.length).toBeGreaterThan(0);
  expect([...mirror].sort()).toEqual([...shepherd].sort());
});
