// The last build step: records the commit the dist was built from in dist/build-info.json, which
// the footer shows and the self-updater checks against /health after a restart.
import { execFileSync } from "node:child_process";
import { BUILD_INFO_FILE, stampBuildInfo } from "./build-info.js";
import { APP_DIR } from "./paths.js";

const git = (args: string[]): string => execFileSync("git", args, { cwd: APP_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const info = stampBuildInfo(git, BUILD_INFO_FILE, new Date(), (message) => console.warn(message));
if (info) console.log(`stamped ${info.sha.slice(0, 7)}${info.dirty ? " (dirty)" : ""} into ${BUILD_INFO_FILE}`);
