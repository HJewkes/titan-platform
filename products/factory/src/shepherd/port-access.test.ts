import { describe, expect, it } from "vitest";
import { SHEPHERD_COMMAND_MAP, SHEPHERD_COMMANDS, type ShepherdCommandName } from "./commands.js";
import { SHEPHERD_PORT_ACCESS, writesPort } from "./port-access.js";

const isRegistered = (name: string): name is ShepherdCommandName => name in SHEPHERD_COMMAND_MAP;

const declared = (): string[] => Object.keys(SHEPHERD_PORT_ACCESS).sort();

describe("shepherd port access declarations", () => {
  it("every registered shepherd command declares its access, and nothing else does", () => {
    const registered = SHEPHERD_COMMANDS.map((command) => command.name).sort();

    expect(declared()).toEqual(registered);
  });

  it("refuses in-process exactly the commands the hand-kept list named before", () => {
    const refused = SHEPHERD_COMMANDS.map((command) => command.name).filter((name) => isRegistered(name) && writesPort(name, {}));

    expect(refused.sort()).toEqual(["shepherd.hold", "shepherd.merge", "shepherd.release", "shepherd.repair-stop", "shepherd.resync", "shepherd.review"]);
  });

  it("a list-or-write command reads on list and writes on any other action", () => {
    expect(writesPort("shepherd.repair-stop", { action: "list" })).toBe(false);
    expect(writesPort("shepherd.repair-stop", { action: "set" })).toBe(true);
    expect(writesPort("shepherd.repair-stop", { action: "clear" })).toBe(true);
  });

  it("a write command is refused even when its args carry a list action", () => {
    expect(writesPort("shepherd.hold", { action: "list" })).toBe(true);
  });

  it("a read command is never refused, whatever its action", () => {
    expect(writesPort("shepherd.freeze", { action: "freeze" })).toBe(false);
    expect(writesPort("shepherd.status", {})).toBe(false);
  });
});
