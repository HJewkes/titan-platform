import { describe, expect, it } from "vitest";
import { deployCheckoutPath, deployedBinPath } from "./deploy-checkout.js";

describe("deployCheckoutPath", () => {
  it("defaults to the app data dir's deploy/titan-platform on Linux", () => {
    const path = deployCheckoutPath({ env: { XDG_DATA_HOME: "/xdg/data" }, home: "/srv/tester", platform: "linux" });

    expect(path).toBe("/xdg/data/titan-factory/deploy/titan-platform");
  });

  it("defaults to Application Support on macOS", () => {
    const path = deployCheckoutPath({ env: {}, home: "/srv/tester", platform: "darwin" });

    expect(path).toBe("/srv/tester/Library/Application Support/titan-factory/deploy/titan-platform");
  });

  it("prefers the configured path over the default", () => {
    const path = deployCheckoutPath({ env: {}, home: "/srv/tester", platform: "linux" }, "/srv/deploy/tree");

    expect(path).toBe("/srv/deploy/tree");
  });
});

describe("deployedBinPath", () => {
  it("names the built bin inside the deploy checkout", () => {
    expect(deployedBinPath("/srv/deploy/tree")).toBe("/srv/deploy/tree/products/factory/dist/bin.js");
  });
});
