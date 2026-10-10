import { join } from "node:path";
import { appDirs, type PathOptions } from "@titan-design/app-paths";

const APP_NAME = "titan-factory";
const BIN_RELATIVE = join("products", "factory", "dist", "bin.js");

/**
 * The checkout the service runs from and the deployer fast-forwards. It sits in the data dir so
 * no agent or coordinator has it as a cwd, which is what let a reviewer's in-place checkout
 * block the deploy.
 */
export function deployCheckoutPath(
  opts: PathOptions = {},
  configured?: string
): string {
  return (
    configured ?? join(appDirs(APP_NAME, opts).data, "deploy", "titan-platform")
  );
}

/** The built bin the rendered unit starts. */
export const deployedBinPath = (checkout: string): string =>
  join(checkout, BIN_RELATIVE);
