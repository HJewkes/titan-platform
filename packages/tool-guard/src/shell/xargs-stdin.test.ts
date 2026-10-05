import { describe, expect, it } from "vitest";
import { extractCommands } from "./commands.js";

const shape = (src: string) =>
  extractCommands(src, { cwd: "/home/you/app", home: "/home/you" }).map((c) => ({
    name: c.name,
    args: c.args.map((a) => a.value),
    wrapping: c.wrapping,
  }));

const last = (src: string) => shape(src).at(-1);
const direct = (src: string) => ({ ...last(src), wrapping: [] as string[] });

describe("xargs running a wrapper with the command on stdin", () => {
  it.each([
    ["env", "echo gh pr merge 1 | xargs env", "env gh pr merge 1"],
    ["sudo with NUL records", "printf 'git\\0push origin HEAD:main' | xargs -0 sudo", "sudo git push origin HEAD:main"],
    ["nohup", "echo gh pr merge 1 | xargs nohup", "nohup gh pr merge 1"],
    ["nice -n 5", "echo gh pr merge 1 | xargs nice -n 5", "nice -n 5 gh pr merge 1"],
    ["a wrapper option", "echo git push origin HEAD:main | xargs env -i", "env -i git push origin HEAD:main"],
  ])("resolves the piped words as the command: %s", (_how, piped, typed) => {
    const run = last(piped);
    expect(run).toMatchObject({ ...direct(typed), wrapping: ["xargs"] });
  });

  it("resolves a replace string after a wrapper", () => {
    expect(shape("echo gh pr merge 1 | xargs -I{} env {}")).toContainEqual({ name: "gh", args: ["pr", "merge", "1"], wrapping: ["xargs"] });
  });

  it("keeps a plain xargs command as it was", () => {
    expect(last("echo origin main | xargs git push")).toEqual({ name: "git", args: ["push", "origin", "main"], wrapping: ["xargs"] });
  });

  it("leaves a wrapper's run unchanged when stdin is unknown", () => {
    expect(last("git ls-files -z | xargs -0 env")).toEqual({ name: null, args: [], wrapping: ["xargs"] });
  });

  it("keeps the verdict of an unprotected command fed by an unknown stdin", () => {
    expect(last("git ls-files -z | xargs -0 rm")).toEqual({ name: "rm", args: [], wrapping: ["xargs"] });
  });
});
