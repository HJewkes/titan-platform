import { describe, expect, it } from "vitest";
import { renderLaunchAgentPlist, renderSystemdUserService, type ServiceSpec } from "./index.js";

const spec: ServiceSpec = {
  label: "example.worker",
  description: "Example worker",
  argv: ["/usr/bin/node", "/opt/app/cli.js", "serve"],
  environment: { NODE_ENV: "production", PATH: "/opt/node/bin:/usr/bin" },
  stdoutPath: "/var/log/app/out.log",
  stderrPath: "/var/log/app/err.log",
};

const line = (text: string, prefix: string): string | undefined => text.split("\n").find((l) => l.startsWith(prefix));

describe("renderSystemdUserService", () => {
  it("renders the whole unit byte for byte", () => {
    expect(renderSystemdUserService(spec)).toBe(
      [
        "[Unit]",
        "Description=Example worker",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        "ExecStart=/usr/bin/node /opt/app/cli.js serve",
        "Restart=always",
        "RestartSec=5",
        'Environment="NODE_ENV=production"',
        'Environment="PATH=/opt/node/bin:/usr/bin"',
        "StandardOutput=append:/var/log/app/out.log",
        "StandardError=append:/var/log/app/err.log",
        "",
        "[Install]",
        "WantedBy=default.target",
        "",
      ].join("\n"),
    );
  });

  it("quotes an argv entry containing spaces", () => {
    const unit = renderSystemdUserService({ ...spec, argv: ["/usr/bin/node", "/path with spaces/cli.js", "serve"] });
    expect(unit).toContain('ExecStart=/usr/bin/node "/path with spaces/cli.js" serve');
  });

  it("doubles % and escapes $ in a quoted argv entry", () => {
    const unit = renderSystemdUserService({ ...spec, argv: ["/usr/bin/node", "/srv/my x/50%/$HOME/cli.js"] });
    expect(unit).toContain('ExecStart=/usr/bin/node "/srv/my x/50%%/$$HOME/cli.js"');
  });

  it("doubles % and escapes $ in an unquoted argv entry", () => {
    const unit = renderSystemdUserService({ ...spec, argv: ["/usr/bin/node", "--rate=5%", "$VAR"] });
    expect(unit).toContain("ExecStart=/usr/bin/node --rate=5%% $$VAR");
  });

  it("escapes a quote and a backslash in an Environment value", () => {
    const unit = renderSystemdUserService({ ...spec, environment: { GREETING: 'say "hi" \\ bye' } });
    expect(line(unit, "Environment=")).toBe('Environment="GREETING=say \\"hi\\" \\\\ bye"');
  });

  it("doubles % in an Environment value so systemd does not expand a specifier", () => {
    const unit = renderSystemdUserService({ ...spec, environment: { ROOT: "/d/50%/aw" } });
    expect(unit).toContain('Environment="ROOT=/d/50%%/aw"');
  });

  it("keeps a value with a space inside the quotes", () => {
    const unit = renderSystemdUserService({ ...spec, environment: { ROOT: "/srv/data dir/root" } });
    expect(unit).toContain('Environment="ROOT=/srv/data dir/root"');
  });

  it("writes no Environment line for an empty environment", () => {
    expect(renderSystemdUserService({ ...spec, environment: {} })).not.toContain("Environment=");
  });

  it("appends stdout and stderr to the given files", () => {
    const unit = renderSystemdUserService(spec);
    expect(unit).toContain("StandardOutput=append:/var/log/app/out.log");
    expect(unit).toContain("StandardError=append:/var/log/app/err.log");
  });

  it("doubles % in the append: log paths so systemd does not read a specifier", () => {
    const unit = renderSystemdUserService({ ...spec, stdoutPath: "/srv/50%u/out.log", stderrPath: "/srv/50%u/err.log" });
    expect(unit).toContain("StandardOutput=append:/srv/50%%u/out.log");
    expect(unit).toContain("StandardError=append:/srv/50%%u/err.log");
  });

  it("doubles % in the description", () => {
    expect(renderSystemdUserService({ ...spec, description: "100% worker" })).toContain("Description=100%% worker");
  });

  it.each([
    ["never", "Restart=no"],
    ["on-failure", "Restart=on-failure"],
    ["always", "Restart=always"],
  ] as const)("maps restart %s to %s", (restart, expected) => {
    expect(renderSystemdUserService({ ...spec, restart })).toContain(expected);
  });

  it("uses the given RestartSec", () => {
    expect(renderSystemdUserService({ ...spec, restartSec: 30 })).toContain("RestartSec=30");
  });

  it("refuses an environment value with a line break rather than injecting a directive", () => {
    expect(() => renderSystemdUserService({ ...spec, environment: { A: "x\nExecStart=/bin/evil" } })).toThrow(/line break/);
  });
});

describe("renderLaunchAgentPlist", () => {
  it("renders the whole plist byte for byte", () => {
    expect(renderLaunchAgentPlist({ ...spec, launchdProcessType: "Interactive" })).toBe(
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        "<dict>",
        "  <key>Label</key>",
        "  <string>example.worker</string>",
        "  <key>ProgramArguments</key>",
        "  <array>",
        "    <string>/usr/bin/node</string>",
        "    <string>/opt/app/cli.js</string>",
        "    <string>serve</string>",
        "  </array>",
        "  <key>RunAtLoad</key>",
        "  <true/>",
        "  <key>KeepAlive</key>",
        "  <true/>",
        "  <key>ProcessType</key>",
        "  <string>Interactive</string>",
        "  <key>EnvironmentVariables</key>",
        "  <dict>",
        "    <key>NODE_ENV</key>",
        "    <string>production</string>",
        "    <key>PATH</key>",
        "    <string>/opt/node/bin:/usr/bin</string>",
        "  </dict>",
        "  <key>StandardOutPath</key>",
        "  <string>/var/log/app/out.log</string>",
        "  <key>StandardErrorPath</key>",
        "  <string>/var/log/app/err.log</string>",
        "</dict>",
        "</plist>",
        "",
      ].join("\n"),
    );
  });

  it("omits ProcessType when none is given", () => {
    expect(renderLaunchAgentPlist(spec)).not.toContain("ProcessType");
  });

  it("asks launchd for the process type it was given", () => {
    const plist = renderLaunchAgentPlist({ ...spec, launchdProcessType: "Background" });
    expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Background<\/string>/);
  });

  it("escapes & and < in an argv entry", () => {
    const plist = renderLaunchAgentPlist({ ...spec, argv: ["/usr/bin/node", "/tmp/a&b/<x>.js"] });
    expect(plist).toContain("<string>/tmp/a&amp;b/&lt;x&gt;.js</string>");
    expect(plist).not.toContain("a&b");
  });

  it("escapes & and < in an environment key and value and in the log paths", () => {
    const plist = renderLaunchAgentPlist({
      ...spec,
      environment: { "A&B": "x<y" },
      stdoutPath: "/tmp/a&b/out.log",
      stderrPath: "/tmp/a<b/err.log",
    });
    expect(plist).toContain("<key>A&amp;B</key>");
    expect(plist).toContain("<string>x&lt;y</string>");
    expect(plist).toContain("<string>/tmp/a&amp;b/out.log</string>");
    expect(plist).toContain("<string>/tmp/a&lt;b/err.log</string>");
  });

  it("writes a % and $ in an argv entry as they are, since launchd does not expand them", () => {
    const plist = renderLaunchAgentPlist({ ...spec, argv: ["/usr/bin/node", "50%/$HOME"] });
    expect(plist).toContain("<string>50%/$HOME</string>");
  });

  it("leaves a quote in an environment value as it is", () => {
    const plist = renderLaunchAgentPlist({ ...spec, environment: { GREETING: 'say "hi"' } });
    expect(plist).toContain('<string>say "hi"</string>');
  });

  it("keeps the job alive unconditionally for restart always", () => {
    expect(renderLaunchAgentPlist(spec)).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
  });

  it("restarts only after an unsuccessful exit for restart on-failure", () => {
    const plist = renderLaunchAgentPlist({ ...spec, restart: "on-failure" });
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>\s*<\/dict>/);
  });

  it("does not keep the job alive for restart never", () => {
    expect(renderLaunchAgentPlist({ ...spec, restart: "never" })).toMatch(/<key>KeepAlive<\/key>\s*<false\/>/);
  });
});
