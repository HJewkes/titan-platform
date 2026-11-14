import { describe, expect, it, vi } from "vitest";
import { qualifiedTaskKey } from "./production.js";

describe("qualifiedTaskKey", () => {
  it("warns that the key is not verified and returns it as given when active-work cannot answer", async () => {
    const down = vi.fn<typeof fetch>(async () => Promise.reject(new TypeError("connection refused")));
    const warn = vi.fn<(line: string) => void>();

    const key = await qualifiedTaskKey("demo/DM-1", { env: {}, fetch: down, warn });

    expect(key).toBe("demo/DM-1");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not verified"));
  });
});
