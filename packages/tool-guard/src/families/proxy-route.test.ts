import { describe, expect, it } from "vitest";
import { CommandRebindingError } from "../shell/command-rebinding.js";
import { extractCommands } from "../shell/index.js";
import type { SimpleCommand } from "../shell/commands.js";
import { parseGit } from "../shell/git.js";
import { declaresRouting, gitConfigRoutes, isRoutingVar } from "./proxy-route.js";

function lastCommand(line: string): SimpleCommand {
  const cmd = extractCommands(line, {}).at(-1);
  if (!cmd) throw new Error(`no command in ${line}`);
  return cmd;
}

function gitGlobals(globals: string) {
  const { args } = lastCommand(`git ${globals} push origin feat/x`);
  return args.slice(0, args.length - parseGit(args, null).subArgs.length - 1);
}

describe("isRoutingVar", () => {
  it.each([
    "https_proxy", "HTTPS_PROXY", "http_proxy", "All_Proxy", "ftp_proxy", "GIT_PROXY_COMMAND", "GIT_SSH",
    "GIT_SSH_COMMAND", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_3", "GIT_CONFIG_VALUE_0",
    "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "CURL_HOME", "WGETRC",
  ])("routes through %s", (name) => {
    expect(isRoutingVar(name)).toBe(true);
  });

  it.each(["no_proxy", "NO_PROXY", "GIT_CONFIG_NOSYSTEM", "PATH", "https_proxy_x", "x_https_proxy", "GIT_CONFIG_KEY_"])(
    "does not route through %s",
    (name) => {
      expect(isRoutingVar(name)).toBe(false);
    },
  );
});

describe("declaresRouting", () => {
  it.each([
    "export https_proxy=x",
    "export A=1 https_proxy=x",
    "export https_proxy",
    "declare -x HTTPS_PROXY=x",
    "typeset -gx all_proxy=x",
    "local -x https_proxy=x",
    "readonly https_proxy=x",
    "export -- https_proxy=x",
    "export GIT_PROXY_COMMAND=/tmp/p",
    "export https_proxy=$P",
    "export https_proxy=$(cat /tmp/p)",
    "export https_proxy+=http://evil",
    "export https_proxy+=",
    "declare -x ALL_PROXY+=x",
  ])("reads %s as routing", (line) => {
    expect(declaresRouting(lastCommand(line))).toBe(true);
  });

  // A run-time export name may be any name, so the walk refuses it as a possible rebinding before routing is read (TP-3320).
  it.each([
    "export $N=x",
    "export $N",
    'export "${V}=x"',
    "export $(echo https_proxy)=x",
  ])("refuses %s before reading it as routing", (line) => {
    expect(() => lastCommand(line)).toThrow(CommandRebindingError);
  });

  it.each([
    "export https_proxy=",
    "export -n https_proxy",
    "export NO_PROXY=x",
    "export no_proxy=x",
    "export PATH=$PATH:/x",
    "export A=$(echo x)",
    "unset https_proxy",
    "echo https_proxy=x",
    "env https_proxy=x curl u",
  ])("does not read %s as routing", (line) => {
    expect(declaresRouting(lastCommand(line))).toBe(false);
  });
});

describe("gitConfigRoutes", () => {
  it.each([
    "-c http.proxy=x",
    "-c HTTP.Proxy=x",
    "-c http.https://github.com.proxy=x",
    "-c remote.origin.proxy=x",
    "-c remote.origin.pushurl=x",
    "-c remote.origin.url=x",
    "-c url.https://e/.pushInsteadOf=https://github.com/",
    "-c url.https://e/.insteadOf=https://github.com/",
    "-c core.gitProxy=nc",
    "-c core.sshCommand=ssh",
    "-c include.path=/tmp/c",
    "-c includeIf.gitdir:/x.path=/tmp/c",
    "--config-env=http.proxy=P",
    "--config-env http.proxy=P",
    "-c user.name=x -c http.proxy=x",
    "-c $C",
    "-c $(cat /tmp/c)",
    "--config-env=$K=P",
    '--config-env "url.https://evil/x=$V"',
    '--config-env="url.https://evil/x=$V"',
    '--config-env "http.x=$V"',
    "--config-env http.x=$(cat /tmp/v)",
    "-c http.curloptResolve=github.com:443:1.2.3.4",
    "-c http.https://github.com.curlOptResolve=github.com:443:1.2.3.4",
  ])("reads git %s push as routing", (globals) => {
    expect(gitConfigRoutes(gitGlobals(globals))).toBe(true);
  });

  it.each([
    "-c http.sslVerify=false",
    "-c http.proxyAuthMethod=basic",
    "-c user.name=x",
    "-c user.name=$U",
    "-C /tmp",
    "--no-pager",
    "--config-env=user.name=P",
    "--config-env user.name=P",
    '-c "url.https://e/x=$V"',
  ])("does not read git %s push as routing", (globals) => {
    expect(gitConfigRoutes(gitGlobals(globals))).toBe(false);
  });

  it("reads no globals as not routing", () => {
    expect(gitConfigRoutes(gitGlobals(""))).toBe(false);
  });
});
