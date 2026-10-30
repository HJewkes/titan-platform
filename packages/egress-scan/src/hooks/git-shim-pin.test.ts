import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withPinnedGitProtocols } from "@titan-design/worktree";
import { afterAll, describe, expect, it } from "vitest";
import { gitShimScript } from "./git-shim.js";
import { installExecutable } from "./git-shim.fixture.js";

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "egress-git-shim-pin-")));
afterAll(() => fs.rmSync(SCRATCH, { recursive: true, force: true }));

// Stands in for the real git: answers the shim's ext check, and prints the pin it was run with.
const PRINTING_GIT = `#!/bin/sh
case " $* " in
*" --get protocol.ext.allow "*) echo never; exit 0 ;;
*" config "*) exit 1 ;;
esac
printf 'GIT_ALLOW_PROTOCOL=%s\\n' "\${GIT_ALLOW_PROTOCOL-<unset>}"
env | grep '^GIT_CONFIG_' | sort
`;

function shim(): string {
  const dir = fs.mkdtempSync(path.join(SCRATCH, "case-"));
  const real = path.join(dir, "real-git");
  installExecutable(real, PRINTING_GIT);
  const file = path.join(dir, "git");
  installExecutable(file, gitShimScript(real, path.join(dir, "git-hooks"), ["status"], "", "/bin/sh"));
  return file;
}

const printed = (env: NodeJS.ProcessEnv): string[] => {
  const lines = Object.entries(env)
    .filter(([key]) => key.startsWith("GIT_CONFIG_"))
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  return [`GIT_ALLOW_PROTOCOL=${env.GIT_ALLOW_PROTOCOL ?? "<unset>"}`, ...lines];
};

const EXT_NEVER = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.ext.allow", GIT_CONFIG_VALUE_0: "never" };

describe("the git shim's protocol pin", () => {
  it.each<[string, NodeJS.ProcessEnv]>([
    ["no list", {}],
    ["an empty list", { GIT_ALLOW_PROTOCOL: "" }],
    ["the legacy full list", { GIT_ALLOW_PROTOCOL: "file:git:http:https:ssh" }],
    ["ext alone", { GIT_ALLOW_PROTOCOL: "ext" }],
    ["ext among safe transports", { GIT_ALLOW_PROTOCOL: "ext:https::ssh" }],
    ["a narrower safe list", { GIT_ALLOW_PROTOCOL: "file:ssh" }],
    ["an earlier config pair", { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: "/hooks" }],
    ["the ext pair already last", EXT_NEVER],
  ])("hands git the environment pinGitProtocols gives, under %s", (_label, caller) => {
    const run = spawnSync(shim(), ["status"], { env: { PATH: "/usr/bin:/bin", ...caller }, encoding: "utf8" });

    expect(run.stderr).toBe("");
    expect(run.stdout.trim().split("\n")).toEqual(printed(withPinnedGitProtocols(caller)));
  });
});
