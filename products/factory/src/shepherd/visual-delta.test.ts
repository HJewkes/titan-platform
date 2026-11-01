import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { componentOf } from "./visual-delta.js";

describe("componentOf", () => {
  it("names a story shot by its story title", () => {
    const path = "packages/ui/tests/visual/reference/stories.spec.ts-snapshots/custom-workout-mesocard--default-chromium-linux.png";

    expect(componentOf(path)).toBe("custom-workout-mesocard");
  });

  it("names a specimen shot by its spec's stem and the snapshot", () => {
    const path = "packages/ui/specimen/baseline/set-row.screenshot.test.ts-snapshots/completed-chromium-linux.png";

    expect(componentOf(path)).toBe("set-row/completed");
  });

  it("falls back to the bare snapshot name outside either layout", () => {
    expect(componentOf("docs/shots/hero.png")).toBe("hero");
  });
});

describe("factory runtime code", () => {
  it("never imports pngjs, so untrusted snapshots only reach the bounded decoder", () => {
    const src = fileURLToPath(new URL("..", import.meta.url));
    const runtime = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.[cm]?tsx?$/.test(path) && !/\.test(-helpers)?\.ts$/.test(path));

    const importers = runtime.filter((path) => /["']pngjs["']/.test(readFileSync(join(src, path), "utf8")));

    expect(runtime.length).toBeGreaterThan(100);
    expect(importers).toEqual([]);
  });
});
