import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bakedShaOf, distBuildSha } from "./dist-build.js";

const SHA = "a".repeat(40);
const bundle = (sha: string): string => `var x = 1;\nfunction buildSha() {\n  return "${sha}";\n}\n`;

function checkoutWithDist(files: Record<string, string>): string {
  const checkout = mkdtempSync(join(tmpdir(), "dist-build-"));
  const dist = join(checkout, "products", "factory", "dist");
  mkdirSync(dist, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dist, name), text);
  return checkout;
}

describe("distBuildSha", () => {
  it("reads the sha baked into a bundle chunk, whatever the checkout's git HEAD says", () => {
    const checkout = checkoutWithDist({ "bin.js": "import './chunk-1.js';", "chunk-1.js": bundle(SHA) });

    expect(distBuildSha(checkout)).toBe(SHA);
  });

  it("is undefined when the dist is absent", () => {
    expect(distBuildSha(mkdtempSync(join(tmpdir(), "dist-build-")))).toBeUndefined();
  });

  it("is undefined when no chunk carries a baked sha", () => {
    expect(distBuildSha(checkoutWithDist({ "bin.js": "console.log(1);" }))).toBeUndefined();
  });
});

describe("bakedShaOf", () => {
  it("keeps a dirty suffix and an unknown bake", () => {
    expect(bakedShaOf(bundle(`${SHA}-dirty`))).toBe(`${SHA}-dirty`);
    expect(bakedShaOf(bundle("unknown"))).toBe("unknown");
  });
});
