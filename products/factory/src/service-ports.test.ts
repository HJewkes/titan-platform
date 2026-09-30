import { describe, expect, it } from "vitest";
import { runCommand } from "./service-ports.js";

describe("runCommand", () => {
  it("resolves with the output of a command that exits 0", async () => {
    expect(await runCommand(process.execPath, ["-e", "process.stdout.write('loaded')"])).toEqual({ code: 0, stdout: "loaded", stderr: "" });
  });

  it("resolves with the exit code and stderr of a command that fails, instead of rejecting", async () => {
    const result = await runCommand(process.execPath, ["-e", "process.stderr.write('Bootstrap failed'); process.exit(5)"]);

    expect(result).toEqual({ code: 5, stdout: "", stderr: "Bootstrap failed" });
  });

  it("resolves undefined when the binary is not on PATH", async () => {
    expect(await runCommand("tp-574-no-such-binary", ["mcp", "add"])).toBeUndefined();
  });
});
