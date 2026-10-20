import { DEFAULT_CLASS_RULES, type ClassRules } from "@titan-design/review-panel";

/** Shepherd's merge-policy files. These tables sit apart from registration-hold.ts so risk-tier.ts can read them without an import cycle through policy.ts. */
export const MERGE_POLICY_FILES = ["g10-*.ts", "adversary-*.ts", "merge-evidence-gate.ts", "task-kind.ts", "registration-hold.ts", "release-head.ts", "risk-tier.ts"].map((name) => `**/${name}`);
/** Shepherd's hold, release, seat and reviewer-choice code, matched by exact path because the names are common elsewhere. */
export const HOLD_COMMAND_FILES = ["commands.ts", "operator-hold.ts", "seats.ts", "release.ts", "reviewer-choice.ts"].map((name) => `products/factory/src/shepherd/${name}`);
/**
 * The owner's own levers: the console's tap and inbox actions, gate resolution and owner release (titan-coord's E1
 * amendment to 458). Globbed by name stem, so a helper split out of one of these files stays held.
 */
export const OWNER_ACTION_FILES = ["apps/console/server/**/owner-tap*.ts", "apps/console/server/**/inbox-actions*.ts", "products/factory/src/**/gate-resolve*.ts", "products/factory/src/**/*owner-release*.ts"];

/** agent-chat's leak guard, self-grant, permission hook and host directory (owner decision 350 Q5), and its agent profiles (458 E1); test files stay exempt in the panel. */
const AGENT_CHAT_SECURITY_FILES = ["src/leak-guard/**", "src/agents/*self-grant*", "src/cli/verbs/permission-hook.ts", "src/broker/host-directory.ts", "profiles/*.json", "src/agents/profile*.ts"];

/** Shepherd's merge policy and the owner's levers live in plain source files, which the panel's default globs miss. */
export const SHEPHERD_CLASS_RULES: ClassRules = {
  ...DEFAULT_CLASS_RULES,
  policy: [...DEFAULT_CLASS_RULES.policy, ...MERGE_POLICY_FILES, ...HOLD_COMMAND_FILES, ...OWNER_ACTION_FILES],
  security: [...DEFAULT_CLASS_RULES.security, ...AGENT_CHAT_SECURITY_FILES],
};
