import { ArConfigSchema, type ArConfig } from "../autoresearch/config.js";

/** A synthetic `autoresearch` config section under `root`; every target is a placeholder unless a test gives it a clone. */
export function arConfigFixture(root: string, targets: Record<string, { clone: string; validatorCasesFile?: string }> = {}): ArConfig {
  return ArConfigSchema.parse({
    agentChatBin: `${root}/bin/agent-chat`,
    configDir: `${root}/agents-config`,
    account: "fixture@example.invalid",
    workRoot: `${root}/work`,
    archiveDir: `${root}/archive`,
    registryPath: `${root}/registry.jsonl`,
    inboxDir: `${root}/inbox`,
    stages: { planner: { profile: "ar-planner" }, implementer: { profile: "ar-implementer" } },
    load: { ceiling: 1000, pollMs: 10 },
    limits: { pool: "autoresearch", path: `${root}/limits.json` },
    targets: Object.fromEntries(Object.entries(targets).map(([name, target]) => [name, { adapterDir: "ar", ...target }])),
  });
}
