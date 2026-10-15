import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

it("lint:types runs eslint with a heap cap above its measured 5.34 GB peak", () => {
  const { scripts } = JSON.parse(
    readFileSync(join(ROOT, "package.json"), "utf8")
  );

  const cap = /^NODE_OPTIONS=--max-old-space-size=(\d+) eslint /.exec(
    scripts["lint:types"]
  );

  expect(cap).not.toBeNull();
  expect(Number(cap[1])).toBeGreaterThanOrEqual(6144);
});
