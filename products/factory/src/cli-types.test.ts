import { describe, expect, it } from "vitest";
import { relativeImports } from "./test-support/relative-imports.js";

describe("cli-types leaf", () => {
  it("imports exactly the modules its types name, and not cli.ts, so no verb file can close a cycle through it", () => {
    expect(relativeImports("cli-types.ts").sort()).toEqual([
      "./blocker/link.js",
      "./bot-identity.js",
      "./ci-timing-fallback.js",
      "./definition.js",
      "./deploy-behind.js",
      "./deploy-cli-link.js",
      "./deploy-watch.js",
      "./deploy.js",
      "./eligibility/back-pressure.js",
      "./gate-answer-rpc.js",
      "./gate-notify-sweep.js",
      "./github-sources/mode.js",
      "./host.js",
      "./owner-gates/audit-command.js",
      "./planner/command.js",
      "./reconciler/bot-ports.js",
      "./serve-ingress.js",
      "./service-check.js",
      "./service-control.js",
      "./shepherd/bump-consumers.js",
      "./shepherd/deploy-pacer.js",
      "./shepherd/fixer-retire.js",
      "./shepherd/main-watch.js",
      "./shepherd/register-identity.js",
      "./shepherd/seat-digest.js",
    ]);
  });
});
