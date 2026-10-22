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
  const gate = section.slice(section.indexOf("### F11 gate {#f11-gate}"), section.indexOf("### Reconciler health and cost"));
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

describe("the reconciler health and cost guide", () => {
  const anchor = "### Reconciler health and cost {#reconciler-health-cost}";
  const health = section.slice(section.indexOf(anchor), section.indexOf("### Go-live"));
  const serveReconciler = readFileSync(new URL("../serve-reconciler.ts", import.meta.url), "utf8");
  const service = readFileSync(new URL("../reconciler/service.ts", import.meta.url), "utf8");
  const botIdentity = readFileSync(new URL("../bot-identity.ts", import.meta.url), "utf8");

  it("is linked from the F11 gate under the anchor it declares", () => {
    expect(section).toContain(anchor);
    expect(section.replace(health, "")).toContain("(#reconciler-health-cost)");
  });

  it("names each health value serve reports for the reconciler", () => {
    expect(serveReconciler).toContain('export type ReconcilerHealth = "running" | "disabled" | "no-bot";');
    for (const value of ["running", "disabled", "no-bot"]) expect(health).toContain(`| \`${value}\` |`);
  });

  it("names the no-bot log line and each reason it carries", () => {
    expect(serveReconciler).toContain('context.log.warn({ reason: bot }, "reconciler.no-bot");');
    expect(serveReconciler).toContain('ServeBot | "absent" | "refused" | "no-login"');
    expect(health).toContain("`reconciler.no-bot`");
    for (const reason of ["absent", "refused", "no-login"]) expect(health).toContain(`| \`${reason}\` |`);
    expect(botIdentity).toContain("export const BOT_LOGIN");
    expect(health).toContain("`BOT_LOGIN`");
  });

  it("names the cost line and each field it logs", () => {
    expect(service).toContain('deps.log.info({ repo, ...cost }, "reconciler.cost");');
    expect(health).toContain("`reconciler.cost`");
    expect(health).toContain("| `repo` |");
    for (const field of ["graphqlCost", "restCalls", "notModified", "appended"]) {
      expect(service).toContain(`\n  ${field}: `);
      expect(health).toContain(`| \`${field}\` |`);
    }
  });
});
