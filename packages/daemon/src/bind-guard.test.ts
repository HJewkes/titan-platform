import { describe, expect, it } from "vitest";
import { isLoopbackHost, NonLoopbackBindError } from "./bind-guard.js";

describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1", "[::1]", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "localhost", "LOCALHOST", "LocalHost"])(
    "accepts %s",
    (host) => expect(isLoopbackHost(host)).toBe(true),
  );

  it.each(["0.0.0.0", "::", "[::]", "", "  ", "192.168.1.20", "10.0.0.1", "128.0.0.1", "126.255.255.255", "example.com", "localhost.evil.test", "127.0.0.1.evil.test", "127.0.0.256", "::ffff:192.168.1.20", "::2", "::1.2.3.4", "::1.0.0.0", "::1%en0", "[::1%en0]", "::ffff:127.0.0.1%en0", "::1:0", "::0001:zz"])(
    "refuses %j",
    (host) => expect(isLoopbackHost(host)).toBe(false),
  );
});

describe("NonLoopbackBindError", () => {
  it("carries the rejected host", () => {
    const err = new NonLoopbackBindError("0.0.0.0");
    expect(err.host).toBe("0.0.0.0");
    expect(err.name).toBe("NonLoopbackBindError");
    expect(err.message).toContain("0.0.0.0");
  });
});
