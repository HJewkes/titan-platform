// The last build step: records the commit the dist was built from in dist/build-info.json, which
// the footer shows and the self-updater checks against /health after a restart.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { BUILD_INFO_FILE, buildInfoOf } from "./build-info.js";
import { APP_DIR } from "./paths.js";

const git = (args: string[]): string => execFileSync("git", args, { cwd: APP_DIR, encoding: "utf8" });

const info = buildInfoOf({ head: git(["rev-parse", "HEAD"]), status: git(["status", "--porcelain", "--untracked-files=no"]) }, new Date());
writeFileSync(BUILD_INFO_FILE, `${JSON.stringify(info, null, 2)}\n`);
console.log(`stamped ${info.sha.slice(0, 7)}${info.dirty ? " (dirty)" : ""} into ${BUILD_INFO_FILE}`);
