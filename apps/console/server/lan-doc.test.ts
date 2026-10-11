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
  it("binds the tailnet address through TITAN_CONSOLE_HOST", () => {
    expect(documentedUnit()).toMatch(/^Environment=TITAN_CONSOLE_HOST=<tailnet-ip>$/m);
  });

  it("serves HTTPS with a certificate and key, under the tailnet name", () => {
    const unit = documentedUnit();

    expect(unit).toMatch(/^Environment=TITAN_CONSOLE_TLS_CERT=\S+\.crt$/m);
    expect(unit).toMatch(/^Environment=TITAN_CONSOLE_TLS_KEY=\S+\.key$/m);
    expect(unit).toMatch(/^Environment=TITAN_CONSOLE_LAN_NAMES=<fqdn>$/m);
  });

  it("carries no unauthenticated flag and leaves owner writes off", () => {
    expect(documentedUnit()).not.toMatch(/allowUnauthenticated/i);
    expect(documentedUnit()).not.toMatch(/OWNER_WRITES/);
  });

  it("retries a failed bind forever", () => {
    expect(documentedUnit()).toMatch(/^StartLimitIntervalSec=0$/m);
  });

  it("names no real address", () => {
    expect(documentedUnit()).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    expect(readFileSync(DOC, "utf8")).not.toMatch(/\b(?:100|192\.168)\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/);
  });
});

describe("the documented checks", () => {
  it("proves plain HTTP gets no reply and the tailnet name answers 401 over HTTPS", () => {
    const doc = readFileSync(DOC, "utf8");

    expect(doc).toContain("curl -sS http://<tailnet-ip>:7500/");
    expect(doc).toContain("https://<fqdn>:7500/` | `401`");
  });
});
