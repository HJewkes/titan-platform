import { compileGlobs } from "@titan-design/fix-proof";
import { resolveConfig, type BurdenConfig } from "./config.js";

export type PathClass = "test" | "ignored" | "production";

/** A classifier compiled once for a whole diff; test globs win over ignored ones, so a fixture `.md` is test material. */
export function pathClassifier(config: Partial<BurdenConfig> = {}): (path: string) => PathClass {
  const resolved = resolveConfig(config);
  const isTest = compileGlobs(resolved.testGlobs);
  const isIgnored = compileGlobs([...resolved.ignoredGlobs, ...resolved.generatedGlobs]);
  return (path) => (isTest(path) ? "test" : isIgnored(path) ? "ignored" : "production");
}

export function classifyPath(path: string, config: Partial<BurdenConfig> = {}): PathClass {
  return pathClassifier(config)(path);
}
