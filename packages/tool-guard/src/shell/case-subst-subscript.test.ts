import { describe, expect, it } from "vitest";
import type { ReadFs } from "../context.js";
import { nodeContext } from "../context.js";
import { decide } from "../decide.js";
import type { HookPort } from "../hook.js";
import { handle } from "../hook.js";

const HOME = "/home/you";
const noFs: ReadFs = {
  realpath: () => {
    throw new Error("ENOENT");
  },
  readHead: () => {
    throw new Error("ENOENT");
  },
  isFile: () => false,
};
const port: HookPort = { context: nodeContext(HOME, noFs), now: () => new Date("2026-01-02T03:04:05.000Z"), loadDecide: async () => decide };

async function decisionOf(command: string): Promise<string | null> {
  const input = JSON.stringify({ tool_name: "Bash", session_id: "s", tool_use_id: "t", cwd: `${HOME}/app`, tool_input: { command } });
  const { stdout } = await handle(input, {}, port);
  if (stdout === "") return null;
  return stdout.includes('"permissionDecision":"deny"') ? "deny" : stdout;
}

const PUSH = "git push origin HEAD:main";

describe("a case-pattern ) inside $( ) inside a subscript", () => {
  it.each([
    ["a) in echo", `echo $(case x in a) ${PUSH};; esac)`],
    ["a) in an assignment", `y=$(case x in a) ${PUSH};; esac)`],
    ["a)", `x[$(case x in a) ${PUSH};; esac)]=1`],
    ["(a)", `x[$(case x in (a) ${PUSH};; esac)]=1`],
    ["a|b)", `x[$(case x in a|b) ${PUSH};; esac)]=1`],
    ["quoted 'a')", `x[$(case x in 'a') ${PUSH};; esac)]=1`],
    ['quoted "a")', `x[$(case x in "a") ${PUSH};; esac)]=1`],
    ["a) with a ] in the body", `x[$(case x in a) echo ]; ${PUSH};; esac)]=1`],
    ["(a) with a ] in the body", `x[$(case x in (a) echo ]; ${PUSH};; esac)]=1`],
    ["a|b) with a ] in the body", `x[$(case x in a|b) echo ]; ${PUSH};; esac)]=1`],
    ["'a') with a ] in the body", `x[$(case x in 'a') echo ]; ${PUSH};; esac)]=1`],
    ["a) with a ] in the body, spaced", `x[ $(case x in a) echo ]; ${PUSH};; esac) ]=1`],
    ["a) with a ] in the body, after ((", `((1)); x[$(case x in a) echo ]; ${PUSH};; esac)]=1`],
    ["a) with a ] in the body, then a command", `x[$(case x in a) echo ] ;; esac)]=1; ${PUSH}`],
    ["a) with a ] in the body, expanded", `echo "$y[$(case x in a) echo ]; ${PUSH};; esac)]"`],
    ["a) with a ] in the body, in an array", `declare -A m; m[$(case x in a) echo ]; ${PUSH};; esac)]=1`],
  ])("guard refuses %s", async (_name, command) => {
    expect(await decisionOf(command)).toBe("deny");
  });
});

describe("a substitution holding a case statement that is harmless", () => {
  it.each([
    ["a pattern list", "echo $(case x in a|b) echo hi;; c) echo no;; esac)"],
    ["a parenthesised pattern and a subshell", "echo $(case x in (a) (echo hi);; esac)"],
    ["a subscript", "x[$(case x in a) echo 1;; esac)]=1"],
  ])("guard allows %s", async (_name, command) => {
    expect(await decisionOf(command)).toBeNull();
  });

  it("guard refuses a command that follows the substitution", async () => {
    expect(await decisionOf(`echo $(case x in a) echo hi;; esac); ${PUSH}`)).toBe("deny");
  });

  it("guard refuses a substitution whose case never reaches esac", async () => {
    expect(await decisionOf(`echo $(case x in a) ${PUSH})`)).toBe("deny");
  });
});

describe("case and esac read by their grammar position inside $( )", () => {
  const nested = `case x in a) case y in b) :;; esac;; c) ${PUSH};; esac`;
  const esacPattern = `case x in (esac) :;; c) ${PUSH};; esac`;
  it.each([
    ["a case nested in a pattern body, quoted", `echo "$(${nested})"`],
    ["a case nested in a pattern body", `echo $(${nested})`],
    ["a case nested in a pattern body, in a subscript", `x[$(${nested})]=1`],
    ["an (esac) pattern, quoted", `echo "$(${esacPattern})"`],
    ["an (esac) pattern", `echo $(${esacPattern})`],
    ["an (esac) pattern, in a subscript", `x[$(${esacPattern})]=1`],
    ["an esac with no case", "echo $(esac)"],
    ["an esac with no case before a pattern end, quoted", `echo "$(esac; c) ${PUSH})"`],
    ["an esac inside a brace group in a body, quoted", `echo "$(case x in a) :; { esac; };; c) ${PUSH};; esac)"`],
    ["an esac inside an if in a body, quoted", `echo "$(case x in a) if :; then esac; fi;; c) ${PUSH};; esac)"`],
  ])("guard refuses %s", async (_name, command) => {
    expect(await decisionOf(command)).toBe("deny");
  });

  it.each([
    ["a (case) pattern", "echo $(case x in (case) echo hi;; esac)"],
  ])("guard allows %s", async (_name, command) => {
    expect(await decisionOf(command)).toBeNull();
  });
});
