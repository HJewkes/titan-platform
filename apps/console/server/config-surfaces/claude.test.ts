import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseTerms, scanText } from "@titan-design/egress-scan";
import type { ConfigRow, ConfigSurfaces } from "./catalog.js";
import { claudeJsonFacts, claudeSurfaces } from "./claude.js";

/** Built at runtime so no token-shaped literal is committed. */
const OAUTH_TOKEN = `sk-ant-oat01-${"B".repeat(40)}`;
const ENV_TOKEN = `ghp_${"C".repeat(36)}`;
const ACCOUNT_EMAIL = "someone@example.test";
const HOOK_EXTRA = "hook-extra-value-5d20";
const MCP_SECRET = "mcp-header-value-e61f";
const PROJECT_DIR = "/srv/work/project-trusted";

const SETTINGS = {
  permissions: { allow: ["Bash(git status:*)", "Read"], deny: ["Bash(rm -rf:*)"], ask: [], defaultMode: "auto" },
  autoMode: { allow: ["Routine edits under the scratch dir are allowed."], soft_deny: ["Pushing to main."], environment: ["A single trusted host."] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "node /opt/hooks/guard.mjs", timeout: 5, note: HOOK_EXTRA }] }],
    Notification: [{ hooks: [{ type: "command", command: "notify-send done" }] }],
  },
  env: { GITHUB_TOKEN: ENV_TOKEN },
  apiKeyHelper: "print-key --account a",
  model: "model-a",
  enabledPlugins: { "plugin-a@market": true },
};

const CLAUDE_JSON = {
  oauthAccount: { emailAddress: ACCOUNT_EMAIL, accessToken: OAUTH_TOKEN },
  userID: "user-id-0f0f",
  mcpServers: { "server-b": { command: "server-b", env: { AUTH: MCP_SECRET } } },
  projects: {
    [PROJECT_DIR]: { hasTrustDialogAccepted: true, mcpServers: { "server-a": { headers: { authorization: MCP_SECRET } } } },
    "/srv/work/project-other": { hasTrustDialogAccepted: false, mcpServers: { "server-b": {} } },
    "/srv/work/project-third": { hasTrustDialogAccepted: true },
  },
};

const SECRETS = [OAUTH_TOKEN, ENV_TOKEN, ACCOUNT_EMAIL, HOOK_EXTRA, MCP_SECRET, PROJECT_DIR, "user-id-0f0f", "print-key"];

let root: string;

async function writeAccount(dir: string, settings: unknown, claudeJson: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "settings.json"), JSON.stringify(settings, null, 2));
  await writeFile(path.join(dir, ".claude.json"), claudeJson);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "claude-surfaces-"));
  await writeAccount(path.join(root, ".claude"), SETTINGS, JSON.stringify(CLAUDE_JSON));
  await writeAccount(path.join(root, "profiles", "workers"), { model: "model-b" }, JSON.stringify({ projects: {} }));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const accounts = () => ({ dirs: [path.join(root, ".claude")], profilesDir: path.join(root, "profiles") });
const row = (surfaces: ConfigSurfaces, surface: string, field: string): ConfigRow | undefined =>
  surfaces.rows.find((entry) => entry.surface === surface && entry.field === field);

describe("claudeSurfaces", () => {
  it("reads every account: the named dir and each profile dir", async () => {
    const surfaces = await claudeSurfaces(accounts())();

    expect(surfaces.files.map((file) => [file.surface, file.inventory])).toEqual([
      ["claude-settings:claude", 14], ["claude-json:claude", 15], ["claude-settings:workers", 14], ["claude-json:workers", 15],
    ]);
    expect(surfaces.gaps).toEqual([]);
  });

  it("shows permissions and autoMode as their rule texts", async () => {
    const surfaces = await claudeSurfaces(accounts())();

    expect(row(surfaces, "claude-settings:claude", "permissions.allow")?.value).toEqual(["Bash(git status:*)", "Read"]);
    expect(row(surfaces, "claude-settings:claude", "permissions.defaultMode")?.value).toBe("auto");
    expect(row(surfaces, "claude-settings:claude", "autoMode.soft_deny")?.value).toEqual(["Pushing to main."]);
  });

  it("shows each hook event as its matchers and commands, nothing else from the entry", async () => {
    const surfaces = await claudeSurfaces(accounts())();

    expect(row(surfaces, "claude-settings:claude", "hooks.PreToolUse")?.value).toEqual([{ matcher: "Bash", commands: ["node /opt/hooks/guard.mjs"] }]);
    expect(row(surfaces, "claude-settings:claude", "hooks.Notification")?.value).toEqual([{ matcher: null, commands: ["notify-send done"] }]);
  });

  it("derives only the trust count and the MCP names from .claude.json", async () => {
    const surfaces = await claudeSurfaces(accounts())();

    expect(surfaces.rows.filter((entry) => entry.surface === "claude-json:claude")).toEqual([
      expect.objectContaining({ field: "trustedFolders", value: 2, hidden: false, line: 0 }),
      expect.objectContaining({ field: "mcpServers", value: ["server-a", "server-b"], hidden: false, line: 0 }),
    ]);
  });

  it("keeps env, apiKeyHelper, OAuth, project paths and server bodies out of the response", async () => {
    const surfaces = await claudeSurfaces(accounts())();
    const payload = JSON.stringify(surfaces).replaceAll(root, "/srv/fixture");

    expect(row(surfaces, "claude-settings:claude", "env")).toMatchObject({ hidden: true });
    expect(row(surfaces, "claude-settings:claude", "apiKeyHelper")).toMatchObject({ hidden: true });
    expect(scanText(payload, { terms: parseTerms(SECRETS.join("\n")) })).toEqual([]);
  });

  it("reports an unparsable .claude.json as a gap without quoting it", async () => {
    await writeFile(path.join(root, ".claude", ".claude.json"), `{"oauthAccount": {"accessToken": "${OAUTH_TOKEN}"`);

    const surfaces = await claudeSurfaces(accounts())();

    expect(surfaces.gaps).toEqual([`${path.join(root, ".claude", ".claude.json")}: not a valid json object`]);
    expect(JSON.stringify(surfaces)).not.toContain(OAUTH_TOKEN);
  });

  it("reads only the named dirs when no profiles dir is given, and names a missing account's files", async () => {
    const surfaces = await claudeSurfaces({ dirs: [path.join(root, "absent")], profilesDir: null })();

    expect(surfaces.gaps).toEqual([`${path.join(root, "absent", "settings.json")}: missing`, `${path.join(root, "absent", ".claude.json")}: missing`]);
  });
});

describe("claudeJsonFacts", () => {
  it("counts no trust and no servers in a file with neither", () => {
    expect(claudeJsonFacts({ oauthAccount: {} })).toEqual({ trustedFolders: 0, mcpServers: [] });
  });
});
