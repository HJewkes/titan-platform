import { execFileSync } from "node:child_process";
import { defineConfig } from "tsup";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** Bakes the checkout's HEAD into the bundle; `unknown` when git is unavailable, so a build never fails on it. */
function buildSha(): string {
  try {
    const dirty = git("status", "--porcelain", "--untracked-files=no") !== "";
    return `${git("rev-parse", "HEAD")}${dirty ? "-dirty" : ""}`;
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: true,
  define: { __FACTORY_BUILD_SHA__: JSON.stringify(buildSha()) },
});
