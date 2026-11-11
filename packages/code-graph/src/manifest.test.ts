import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Manifest {
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const manifest: Manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
);

describe("code-graph manifest", () => {
  it("declares zod ^4 as a peer because the retrieval entry it loads imports zod", () => {
    expect(manifest.peerDependencies?.zod).toMatch(/^\^4\./);
  });

  it("declares zod ^4 as a dev dependency so the workspace resolves it", () => {
    expect(manifest.devDependencies?.zod).toMatch(/^\^4\./);
  });
});
