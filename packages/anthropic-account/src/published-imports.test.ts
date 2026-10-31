import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The bins run under `npx -p`, where no host supplies a peer and legacy-peer-deps skips peers
// entirely, so every package the published code imports must be a regular dependency (TP-3902).
const root = fileURLToPath(new URL("../", import.meta.url));
const dependencies = dependencyNames();

function dependencyNames(): string[] {
  const manifest: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
  const deps = typeof manifest === "object" && manifest !== null && "dependencies" in manifest ? manifest.dependencies : {};
  return typeof deps === "object" && deps !== null ? Object.keys(deps) : [];
}

const SPECIFIERS = [
  /^(?:import|export)\b[^"]*?\bfrom\s*"([^"]+)"/gm,
  /^import\s*"([^"]+)"/gm,
  /\bimport\(\s*"([^"]+)"\s*\)/g,
];

function packageOf(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
}

function importedPackages(): string[] {
  const dist = join(root, "dist");
  const files = readdirSync(dist, { recursive: true, encoding: "utf-8" }).filter((file) => file.endsWith(".js"));
  const specifiers = files.flatMap((file) => {
    const text = readFileSync(join(dist, file), "utf-8");
    return SPECIFIERS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? ""));
  });
  const bare = specifiers.filter((specifier) => !specifier.startsWith(".") && !specifier.startsWith("node:"));
  return [...new Set(bare.map(packageOf))].filter((name) => !builtinModules.includes(name)).sort();
}

describe("the published dist", () => {
  it("imports only packages listed under dependencies, so the bins run under legacy-peer-deps", () => {
    const missing = importedPackages().filter((name) => !dependencies.includes(name));
    expect(missing).toEqual([]);
  });

  it("is scanned for the packages it really imports, so the dependency check is not vacuous", () => {
    expect(importedPackages()).toEqual(["@titan-design/rpc-protocol", "zod"]);
  });
});
