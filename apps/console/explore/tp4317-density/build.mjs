// Usage: node build.mjs — writes html/<page>-<direction>.html beside this script.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOOP_DIRECTIONS } from "./loops.mjs";
import { TREE_DIRECTIONS } from "./tree.mjs";
import { TYPE_SCALES } from "./type.mjs";

const OUT = join(dirname(new URL(import.meta.url).pathname), "html");
const PAGES = { loops: LOOP_DIRECTIONS, tree: TREE_DIRECTIONS, type: TYPE_SCALES };

mkdirSync(OUT, { recursive: true });
for (const [name, directions] of Object.entries(PAGES)) {
  for (const [direction, render] of Object.entries(directions)) writeFileSync(join(OUT, `${name}-${direction}.html`), render());
}
console.log(`wrote ${Object.values(PAGES).reduce((sum, directions) => sum + Object.keys(directions).length, 0)} pages to ${OUT}`);
