import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const DOC = new URL("../docs/lan.md", import.meta.url);

function documentedUnit(): string {
  const blocks = [...readFileSync(DOC, "utf8").matchAll(/```ini\n([\s\S]*?)```/g)].map((match) => match[1] ?? "");
  const unit = blocks.find((block) => block.includes("[Service]"));
  if (unit === undefined) throw new Error("docs/lan.md has no ini block with a [Service] section");
  return unit;
}

describe("the documented LAN unit", () => {
  it("binds the LAN through TITAN_CONSOLE_HOST", () => {
    expect(documentedUnit()).toMatch(/^Environment=TITAN_CONSOLE_HOST=\S+$/m);
  });

  it("carries no unauthenticated flag", () => {
    expect(documentedUnit()).not.toMatch(/allowUnauthenticated/i);
  });

  it("retries a failed bind forever", () => {
    expect(documentedUnit()).toMatch(/^StartLimitIntervalSec=0$/m);
  });

  it("names no real address", () => {
    expect(documentedUnit()).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });
});
