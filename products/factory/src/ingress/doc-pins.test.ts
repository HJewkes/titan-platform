import { readFileSync } from "node:fs";
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
