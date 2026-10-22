import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const APPS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PackageJson = z.object({ version: z.string() });

function installedReactUi(app: string): { dir: string; version: string } {
  const dir = realpathSync(path.join(APPS, app, "node_modules/@titan-design/react-ui"));
  const { version } = PackageJson.parse(JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")));
  return { dir, version };
}

// Two react-ui copies in one workspace means two theme stylesheets and two component sets drifting apart.
describe("react-ui in the console", () => {
  it("resolves to the same installed copy codewatch uses", () => {
    const consoleCopy = installedReactUi("console");
    const codewatch = installedReactUi("codewatch");

    expect(consoleCopy.version).toBe(codewatch.version);
    expect(consoleCopy.dir).toBe(codewatch.dir);
  });
});
