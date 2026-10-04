#!/usr/bin/env node
// Compiles the owner-presence helper into products/factory/dist with /usr/bin/swiftc.
// Skipped off macOS (CI runs Linux and nothing there needs the helper); a missing helper
// makes confirmOwner return undefined, so the owner class stays unreachable.
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SWIFTC = "/usr/bin/swiftc";

export function buildHelper({ platform = process.platform, root = ROOT, run = execFileSync } = {}) {
  if (platform !== "darwin") return { status: "skipped" };
  const out = join(root, "products", "factory", "dist", "owner-presence");
  mkdirSync(dirname(out), { recursive: true });
  run(SWIFTC, ["-O", join(root, "products", "factory", "native", "owner-presence.swift"), "-o", out], { stdio: "inherit" });
  return { status: "built", out };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const { status, out } = buildHelper();
    console.log(status === "built" ? `built ${out}` : "owner-presence helper skipped: not macOS");
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
