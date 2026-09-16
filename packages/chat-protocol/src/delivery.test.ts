import { describe, expect, it } from "vitest";
import { TRANSPORT_DELIVERY_CEILING, capDeliveryStatus } from "./delivery.js";

describe("capDeliveryStatus", () => {
  it("clamps a claim no transport can observe down to the ceiling", () => {
    expect(capDeliveryStatus("read", "accepted")).toBe("accepted");
    expect(capDeliveryStatus("delivered", "accepted")).toBe("accepted");
  });

  it("leaves a claim weaker than the ceiling alone", () => {
    expect(capDeliveryStatus("pending", "read")).toBe("pending");
  });

  it("never rewrites an outcome that is not progress", () => {
    expect(capDeliveryStatus("held", "accepted")).toBe("held");
    expect(capDeliveryStatus("undeliverable", "accepted")).toBe("undeliverable");
  });

  it("caps at accepted, because every transport titan speaks today reports only acceptance", () => {
    expect(TRANSPORT_DELIVERY_CEILING).toBe("accepted");
  });
});
