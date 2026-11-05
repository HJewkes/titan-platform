#!/usr/bin/env node
// Rewrites doctrine/style-tokens.json from titan-design's published tokens.css (TP-4022).
//   node scripts/pin-style-tokens.mjs <tokens.css> <react-ui version>
// The file is the one the explainer template imports, `@titan-design/react-ui/tokens.css`.
// A style pack may name only these tokens: a pack picks among existing tokens and never adds one.
import { readFile, writeFile } from "node:fs/promises";

const OUT = new URL("../doctrine/style-tokens.json", import.meta.url);

export function tokenNames(css) {
  return [...new Set([...css.matchAll(/(?:^|[\s;{])--([a-zA-Z0-9-]+)\s*:/g)].map((match) => match[1]))].sort();
}

const [cssPath, version] = process.argv.slice(2);
if (!cssPath || !/^\d+\.\d+\.\d+$/.test(version ?? "")) {
  console.error("usage: pin-style-tokens.mjs <tokens.css> <react-ui semver version>");
  process.exit(2);
}
const tokens = tokenNames(await readFile(cssPath, "utf8"));
const pinned = { source: { package: "@titan-design/react-ui", subpath: "tokens.css", version }, tokens };
await writeFile(OUT, `${JSON.stringify(pinned, null, 2)}\n`, "utf8");
console.log(`Wrote doctrine/style-tokens.json: ${tokens.length} tokens from ${version}`);
