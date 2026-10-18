#!/usr/bin/env node
// Rewrites doctrine/visual-router.json from titan-design's visual router (TP-3597 S1c).
//   node scripts/pin-visual-router.mjs <router module> <titan-design commit>
// The module is anything exporting PATTERNS, CATALOGUE and routeVisual: react-ui's built
// dist/visual-router.mjs, or `@titan-design/react-ui/visual-router` once a release ships it.
// Each type carries routeVisual's own answer, so the explainer reads the routing rather than
// re-deriving it; src/visual-router.test.ts fails if the pinned answers stop agreeing.
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const OUT = new URL("../doctrine/visual-router.json", import.meta.url);

function pinType(routeVisual, entry) {
  const { render, closest, gap } = routeVisual({ type: entry.id });
  return { ...entry, route: { render, closest, gap } };
}

export function pinRouter({ PATTERNS, CATALOGUE, routeVisual }, commit) {
  return {
    source: { package: "@titan-design/react-ui", subpath: "visual-router", commit },
    patterns: PATTERNS,
    types: CATALOGUE.map((entry) => pinType(routeVisual, entry)),
  };
}

const [modulePath, commit] = process.argv.slice(2);
if (!modulePath || !/^[0-9a-f]{40}$/.test(commit ?? "")) {
  console.error("usage: pin-visual-router.mjs <router module> <40-hex titan-design commit>");
  process.exit(2);
}
const router = await import(modulePath.startsWith("@") ? modulePath : pathToFileURL(modulePath).href);
await writeFile(OUT, `${JSON.stringify(pinRouter(router, commit), null, 2)}\n`, "utf8");
console.log(`Wrote doctrine/visual-router.json from ${commit.slice(0, 12)}`);
