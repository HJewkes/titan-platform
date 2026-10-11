import { describe, expect, it } from "vitest";
import { ancestorsOf, parsePs, readAncestry } from "./ancestry.js";

const PS = [
  "    1     0 ?        /sbin/init",
  "  100     1 ?        tmux: server    tmux new-session -d",
  "  200   100 pts/3    -zsh",
  "  300   200 pts/3    /home/you/.local/bin/claude --model opus",
  "  400   300 pts/3    /usr/bin/zsh -c source snapshot.sh",
  "  500   400 pts/3    claude -p hi",
  "  600   500 pts/3    /bin/sh -c node bin.js hook",
  "  700   600 pts/3    node bin.js hook",
  "",
].join("\n");

describe("parsePs and ancestorsOf", () => {
  it("lists every process above the hook below init, nearest first, marking each claude and terminal", () => {
    const ancestors = ancestorsOf(parsePs(PS), 700);

    expect(ancestors.map((a) => a.claude)).toEqual([false, true, false, true, false, false]);
    expect(ancestors.map((a) => a.tty)).toEqual([true, true, true, true, true, false]);
  });

  it("reads a command name with a space, and `?` as no terminal", () => {
    const rows = parsePs(PS);

    expect(rows.get(100)).toEqual({ ppid: 1, ancestor: { claude: false, tty: false } });
  });

  it("stops at a parent the table does not list", () => {
    expect(ancestorsOf(parsePs("  700   650 ?  node bin.js"), 700)).toEqual([]);
  });
});

describe("readAncestry", () => {
  it("reads this process's real ancestors from ps", () => {
    expect(readAncestry().length).toBeGreaterThan(0);
  });
});
