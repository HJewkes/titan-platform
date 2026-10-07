import os from "node:os";
import { describe, expect, it } from "vitest";
import { toAbsolutePath } from "./discover.js";
import { expandHome } from "./expand-home.js";

describe("expandHome", () => {
  it("returns the home directory for a bare tilde", () => {
    expect(expandHome("~", "/h")).toBe("/h");
  });

  it("joins a tilde-slash path onto the home directory", () => {
    expect(expandHome("~/a/b", "/h")).toBe("/h/a/b");
  });

  it("leaves absolute, relative and tilde-user paths alone", () => {
    expect(expandHome("/x/y", "/h")).toBe("/x/y");
    expect(expandHome("a/b", "/h")).toBe("a/b");
    expect(expandHome("~other/a", "/h")).toBe("~other/a");
  });

  it("defaults to the os home directory", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });

  it("is what toAbsolutePath uses for a bare tilde", () => {
    expect(toAbsolutePath("~")).toBe(os.homedir());
  });
});
