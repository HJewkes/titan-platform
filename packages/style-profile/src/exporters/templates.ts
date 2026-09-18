import Handlebars from "handlebars";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// tsup bundles into dist/index.js while tests load src/exporters, so the package root sits at different depths.
function findPackageRoot(start: string): string {
  let dir = start;
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`style-profile package root not found above ${start}`);
    dir = parent;
  }
  return dir;
}

export function loadTemplate(name: string): Handlebars.TemplateDelegate {
  const root = findPackageRoot(dirname(fileURLToPath(import.meta.url)));
  const source = readFileSync(join(root, "templates", name), "utf-8");
  return Handlebars.compile(source);
}
