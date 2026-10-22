import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { describe, expect, it } from "vitest";
import { GithubConfigSchema } from "../config.js";
import { INGRESS_PATH, INGRESS_PORT, webhookSecretPath } from "./paths.js";

const guide = readFileSync(new URL("../../../../site/guides/factory.md", import.meta.url), "utf8");
const section = guide.slice(guide.indexOf("## Webhook ingress"), guide.indexOf("## `serve`"));

describe("the webhook ingress guide", () => {
  it("names the path the listener answers", () => {
    expect(section).toContain(`\`${INGRESS_PATH}\``);
  });

  it("names the loopback listener with the port the listener binds", () => {
    expect(section).toContain(`127.0.0.1:${INGRESS_PORT}${INGRESS_PATH}`);
    expect(section).toContain(`sport = :${INGRESS_PORT}`);
  });

  it("names the secret file by its basename", () => {
    expect(section).toContain(basename(webhookSecretPath({})));
  });

  it("names the kill-switch key the config schema declares", () => {
    expect(Object.keys(GithubConfigSchema.parse({}))).toContain("ingress");
    expect(section).toContain('"ingress"');
    expect(section).toContain("github.ingress");
  });
});

describe("the F11 gate guide", () => {
  const gate = section.slice(section.indexOf("### F11 gate {#f11-gate}"), section.indexOf("### Go-live"));
  const sampler = readFileSync(new URL("../../scripts/f11-rate-sample.mjs", import.meta.url), "utf8");

  it("is linked from the ingress section under the anchor it declares", () => {
    expect(gate).not.toBe("");
    expect(section.replace(gate, "")).toContain("(#f11-gate)");
  });

  it("names the sampler's flags as its usage line spells them", () => {
    for (const usage of ["--out <jsonl>", "--peaks <jsonl>"]) {
      expect(sampler).toContain(`f11-rate-sample.mjs ${usage}`);
      expect(gate).toContain(`f11-rate-sample.mjs ${usage}`);
    }
  });

  it("names only reset paths that exist under the factory source", () => {
    for (const path of ["reconciler/", "github-sources/", "event-log/", "ingress/", "head-guard/", "bot-identity.ts"]) {
      expect(gate).toContain(`\`${path}\``);
      expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
    }
  });
});
