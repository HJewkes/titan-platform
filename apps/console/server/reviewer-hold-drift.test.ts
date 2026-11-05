import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..", "..", "..");

/** Source parse, because the console may not import factory code and must not pull it in just for a test. */
function stringsInInitializer(file: string, declaration: RegExp): string[] {
  const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
  const initializer = declaration.exec(source)?.[1];
  if (initializer === undefined) throw new Error(`no matching declaration found in ${file}`);
  return [...initializer.matchAll(/"([^"]+)"/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
}

it("the console reviewer-hold classes mirror Shepherd's HOLD_CLASSES", () => {
  const shepherdClasses = stringsInInitializer("products/factory/src/shepherd/hold-reason.ts", /export const HOLD_CLASSES\s*=\s*\[([^\]]*)\]/);
  const shepherdG10 = shepherdClasses.filter((holdClass) => holdClass.startsWith("g10-"));
  const mirror = stringsInInitializer("apps/console/server/blockers.ts", /const REVIEWER_HOLD_CLASSES[^=]*=\s*new Set\(\[([^\]]*)\]\)/);

  expect(shepherdG10.length).toBeGreaterThan(0);
  expect([...mirror].sort()).toEqual([...shepherdG10].sort());
});
