import { resolveFrom } from "./shell/path.js";

/**
 * One guarded location. `pattern` starts with `~/` (home), `**\/` (any directory) or `/` (the
 * root); `*` and `?` stay within one segment, and a trailing `/**` covers the directory itself
 * and everything under it.
 */
export interface GuardedPath {
  /** Logged instead of the path the agent typed. */
  id: string;
  pattern: string;
  except?: readonly string[];
  /** Concrete paths the pattern covers, for testing a glob or a directory; required when `pattern` has a wildcard. */
  samples?: readonly string[];
}

export interface GuardedList {
  paths: readonly GuardedPath[];
  /** File names distinctive enough to match on their own, as in `find ~ -name .netrc`. */
  basenames: readonly string[];
}

const SECRET: GuardedList = {
  paths: [
    {
      id: "home:.ssh",
      pattern: "~/.ssh/**",
      except: ["~/.ssh/**/*.pub", "~/.ssh/known_hosts"],
      samples: ["~/.ssh/id_ed25519", "~/.ssh/id_rsa", "~/.ssh/id_ecdsa"],
    },
    { id: "home:.aws/credentials", pattern: "~/.aws/credentials" },
    { id: "home:.aws/sso/cache", pattern: "~/.aws/sso/cache/**", samples: ["~/.aws/sso/cache/token.json"] },
    { id: "home:.config/gh/hosts.yml", pattern: "~/.config/gh/hosts.yml" },
    { id: "home:.npmrc", pattern: "~/.npmrc" },
    { id: "home:.netrc", pattern: "~/.netrc" },
    { id: "home:.git-credentials", pattern: "~/.git-credentials" },
    { id: "home:.docker/config.json", pattern: "~/.docker/config.json" },
    { id: "home:.kube/config", pattern: "~/.kube/config" },
    { id: "home:.config/gcloud", pattern: "~/.config/gcloud/**", samples: ["~/.config/gcloud/credentials.db"] },
    wrangler("macos", "~/Library/Preferences/.wrangler/config"),
    wrangler("xdg", "~/.config/.wrangler/config"),
    wrangler("legacy", "~/.wrangler/config"),
    { id: "home:.agent-chat/token", pattern: "~/.agent-chat/*.token", samples: ["~/.agent-chat/ui.token"] },
    { id: "home:.claude/credentials", pattern: "~/.claude*/.credentials.json", samples: ["~/.claude/.credentials.json"] },
    {
      id: "home:.claude-profiles/credentials",
      pattern: "~/.claude-profiles/*/.credentials.json",
      samples: ["~/.claude-profiles/work/.credentials.json"],
    },
    { id: "any:.env", pattern: "**/.env", samples: [".env"] },
    {
      id: "any:.env.*",
      pattern: "**/.env.*",
      except: ["**/.env.example", "**/.env.sample", "**/.env.template"],
      samples: [".env.local"],
    },
  ],
  basenames: ["id_rsa", "id_ed25519", "id_ecdsa", ".netrc", ".git-credentials"],
};

const CONFIG: GuardedList = {
  paths: [
    {
      id: "any:.claude/settings",
      pattern: "**/.claude/settings*.json",
      samples: [".claude/settings.json", ".claude/settings.local.json"],
    },
    { id: "any:.claude/hooks", pattern: "**/.claude/hooks/**", samples: [".claude/hooks/guard.sh"] },
    {
      id: "home:.claude-profiles/settings",
      pattern: "~/.claude-profiles/*/settings*.json",
      samples: ["~/.claude-profiles/work/settings.json"],
    },
    { id: "home:.claude.json", pattern: "~/.claude.json" },
    { id: "managed-settings:macos", pattern: "/Library/Application Support/ClaudeCode/managed-settings.json" },
    { id: "managed-settings:linux", pattern: "/etc/claude-code/managed-settings.json" },
    { id: "home:.claude/CLAUDE.md", pattern: "~/.claude/CLAUDE.md" },
    { id: "home:CLAUDE.md", pattern: "~/CLAUDE.md" },
    { id: "home:.agent-chat/config.json", pattern: "~/.agent-chat/config.json" },
    { id: "home:.agent-chat/profiles", pattern: "~/.agent-chat/profiles/**", samples: ["~/.agent-chat/profiles/work.json"] },
    { id: "any:.git/hooks", pattern: "**/.git/hooks/**", samples: [".git/hooks/pre-push"] },
    { id: "home:egress-terms", pattern: "~/.config/titan-egress/private-terms" },
    {
      id: "home:tool-guard-state",
      pattern: "~/.local/state/titan-tool-guard/**",
      samples: ["~/.local/state/titan-tool-guard/guard.log"],
    },
  ],
  basenames: [],
};

/** The guarded path lists of section 3.3 of the TP-403 plan, fixed by owner decision D4. */
export const GUARDED_PATHS: { readonly secret: GuardedList; readonly config: GuardedList } = {
  secret: SECRET,
  config: CONFIG,
};

function wrangler(where: string, dir: string): GuardedPath {
  return { id: `home:wrangler-${where}`, pattern: `${dir}/**`, samples: [`${dir}/default.toml`] };
}

const HOME_PREFIX_RE = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/;
const GLOB_RE = /[*?[]/;

export function hasGlob(path: string): boolean {
  return GLOB_RE.test(path);
}

/** Replaces a leading `~`, `$HOME` or `${HOME}` with `home`. */
export function expandHome(value: string, home: string): string {
  const prefix = HOME_PREFIX_RE.exec(value);
  return prefix ? home + value.slice(prefix[0].length) : value;
}

/** Absolute paths `value` may name; with no known `dir`, both home and the root are assumed. */
export function toAbsolute(value: string, dir: string | null, home: string): string[] {
  const expanded = expandHome(value, home);
  if (expanded.startsWith("/")) return [resolveFrom("/", expanded)];
  if (dir !== null) return [resolveFrom(dir, expanded)];
  return [resolveFrom(home, expanded), resolveFrom("/", expanded)];
}

/** The entry covering an absolute, wildcard-free path. Matching is by whole segment. */
export function matchGuarded(path: string, list: GuardedList, home: string): GuardedPath | null {
  return list.paths.find((entry) => covers(entry, path, home)) ?? null;
}

/** The first entry one of whose samples the glob `pattern` (absolute) would expand to. */
export function matchGlob(pattern: string, list: GuardedList, home: string): GuardedPath | null {
  const re = globRegExp(pattern);
  return list.paths.find((entry) => samplesOf(entry, home, pattern).some((s) => re.test(s))) ?? null;
}

/** The first entry with a sample strictly under the directory `dir`. */
export function containsGuarded(dir: string, list: GuardedList, home: string): GuardedPath | null {
  const prefix = dir.endsWith("/") ? dir : `${dir}/`;
  return list.paths.find((entry) => samplesOf(entry, home, null).some((s) => s.startsWith(prefix))) ?? null;
}

function covers(entry: GuardedPath, path: string, home: string): boolean {
  if (!patternRegExp(entry.pattern, home).test(path)) return false;
  return !(entry.except ?? []).some((x) => patternRegExp(x, home).test(path));
}

/** Samples as absolute paths. Any-directory samples are grafted onto `near`'s directory, or dropped without it. */
function samplesOf(entry: GuardedPath, home: string, near: string | null): string[] {
  const out: string[] = [];
  for (const sample of entry.samples ?? [entry.pattern]) {
    if (sample.startsWith("~/")) out.push(home + sample.slice(1));
    else if (sample.startsWith("/")) out.push(sample);
    else if (near !== null) out.push(graft(near, sample));
  }
  return out;
}

function graft(near: string, relative: string): string {
  const base = near.split("/");
  const tail = relative.split("/");
  return [...base.slice(0, Math.max(1, base.length - tail.length)), ...tail].join("/");
}

function patternRegExp(pattern: string, home: string): RegExp {
  if (pattern.startsWith("~/")) return globRegExp(home + pattern.slice(1));
  return globRegExp(pattern.startsWith("**/") ? `/${pattern}` : pattern);
}

function globRegExp(glob: string): RegExp {
  let src = "";
  for (let i = 0; i < glob.length; ) {
    const [piece, width] = globPiece(glob, i);
    src += piece;
    i += width;
  }
  return new RegExp(`^${src}$`);
}

/** Regex source for the glob syntax starting at `i`, and how many characters it consumed. */
function globPiece(glob: string, i: number): [string, number] {
  const rest = glob.slice(i);
  if (rest.startsWith("/**/")) return ["(?:/.*)?/", 4];
  if (rest === "/**") return ["(?:/.*)?", 3];
  const c = glob[i] as string;
  if (c === "*") return ["[^/]*", 1];
  if (c === "?") return ["[^/]", 1];
  const end = c === "[" ? glob.indexOf("]", i + 2) : -1;
  if (end > 0) return [`[${glob.slice(i + 1, end).replace(/^!/, "^").replaceAll("\\", "\\\\")}]`, end - i + 1];
  return [c.replace(/[.+^${}()|[\]\\]/g, "\\$&"), 1];
}
