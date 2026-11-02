/** The interpreter the hooks name and the line that hardens them, fixed when the hooks are written. */
interface HookShell {
    /** The interpreter a chain shim's `#!` line names. */
    readonly path: string;
    /** The pre-push hook's whole `#!` line, flags included. */
    readonly shebang: string;
    /** Shell lines every hook runs first, before anything reads the agent's environment. */
    readonly scrub: string;
}
/** Flip to false to let a push through, generic rules only, while the owner has no private term list. */
declare const MISSING_TERMS_REFUSES = true;
/** What the pre-push shim bakes in when it is written, so nothing the agent's environment holds is trusted. */
interface ScanInputs {
    missingTermsRefuses: boolean;
    /** The owner's home from the passwd entry; derives the term list's path. */
    home: string;
    /** The broker's own PATH; the hook bakes its absolute entries only and never uses the agent's PATH. */
    path: string;
    /** Checks the scanner on the PATH the hook bakes once, at write time; absent, every push checks it. */
    probe?: (bakedPath: string) => ScannerFacts | undefined;
}
/** What `titan-egress-scan --help` said when the hooks were written. */
type ScanVerdict = "scans-text" | "skips-binary" | "no-pre-push";
interface ScannerFacts {
    /** The realpath of the scanner the baked PATH finds, which the hook runs as `node <scanner>`. */
    scanner: string;
    /** The node the scanner's env shebang finds on the baked PATH, as found, so an upgrade keeps it. */
    node: string;
    verdict: ScanVerdict;
    /** The scanner's mtime, unchanged across the --help run; the stamp file beside the hooks carries it. */
    mtimeMs: number;
}
/** A `scans-text` verdict and the stamp file whose mtime pins the scanner it was found for. */
interface Bake {
    facts: ScannerFacts;
    stamp: string;
}
declare const termsFileFor: (home: string) => string;
/** How one pre-push hook is written: the bake applies only with a `scans-text` verdict. */
interface PrePushPlan {
    readonly inputs: ScanInputs;
    readonly shell: HookShell;
    readonly shimDirs: readonly string[];
    readonly bake?: Bake;
    readonly noRewrite: boolean;
}
/**
 * The broker's PATH covers the whole hook, not only the scan; the repo hook gets the agent's PATH back.
 * Its git calls skip the agent's git and gh shims, since every exec costs kernel memory (CC-795).
 */
declare const prePushScript: ({ inputs, shell, shimDirs, bake, noRewrite }: PrePushPlan) => string;

/**
 * Client hooks shimmed to chain to the repo's own hook, since overriding the hooks path hides it.
 * Each shim costs a shell and a git call, so the hooks that fire on every commit without gating it
 * (`reference-transaction`, `post-index-change`, `prepare-commit-msg`, `post-commit`) are not
 * chained and do not run for agents. Server-side names never run in an agent's repo.
 */
declare const CHAINED_HOOKS: readonly ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "commit-msg", "pre-rebase", "post-checkout", "post-merge", "post-rewrite", "pre-auto-gc", "sendemail-validate"];
/** Command-scope git config through the environment, so no repo's `.git/config` is written. */
declare const gitHooksEnv: (dir: string) => Record<string, string>;
/** The guard dir a launch env points git at, if any. */
declare const hooksDirOf: (env: Record<string, string>) => string | undefined;
/**
 * Runs the scanner's --help once, the way the hook would, with an environment of PATH alone. A
 * scanner or node that is missing, a help run that fails, is killed or times out, a scanner
 * written within the last two seconds, or one whose mtime moved during the run yields nothing,
 * so the hook keeps checking at every push.
 */
declare function probeScanner(bakedPath: string): ScannerFacts | undefined;
declare function passwdHome(): string;
/** Where the writer puts each hook: the shell they name and the shim dirs their PATH leaves out. */
interface HookSetup {
    readonly shell: HookShell;
    /** The agent's git and gh shim dirs; the hook never pushes, so its git calls skip them. */
    readonly shimDirs: readonly string[];
}
/** Every hook the dir holds, by name: the scanning pre-push and a chain shim per `CHAINED_HOOKS` entry. */
declare function hookScripts(inputs: ScanInputs, { shell, shimDirs }: HookSetup, bake?: Bake, noRewrite?: boolean): Map<string, string>;
/**
 * The hooks dir a `no-rewrite` profile's git runs with (CC-1633): under the guard's own dir, so the
 * pretool's protected path covers it, and with its own git shim dir beside it.
 *
 * git leaves a typed `push --mirror`'s deletions off the hook's stdin, and an agent that first deletes its own
 * refs/remotes/* sends nothing the hook refuses, so the caller must refuse a typed `--mirror` before git runs.
 */
declare const noRewriteHooksDir: (hooksDir: string) => string;
/** The dir's name carries the policy, so a plan that selected it rewrites it the same way on resume. */
declare const isNoRewriteHooksDir: (dir: string) => boolean;
/** Writes the hooks into `dir`; a dir named by `noRewriteHooksDir` also gets the no-rewrite push policy. */
declare function writeGitHooks(dir: string, inputs: ScanInputs, setup: HookSetup): void;
/** Not a hook name, so git never runs it; only its mtime is read. */
declare const STAMP_FILE = "egress-scan.stamp";

/**
 * The interpreter a generated script names on its first line, fixed when the script is written.
 * macOS `/bin/sh` re-execs bash, so dash saves one exec per run; no PATH or env lookup is involved.
 */
declare const posixShell: (probe?: (file: string) => boolean) => string;
/**
 * `-p` makes bash-as-sh ignore SHELLOPTS and imported functions. Dash has no such option (it rejects `-p`)
 * and has no such import, so it needs none; any other interpreter keeps the flag.
 */
declare const hardenedShebang: (shell: string) => string;
/**
 * Bash `-p` ignores the inherited SHELLOPTS and keeps the variable read-only; dash, ash and other sh
 * export it untouched, so a hostile `noexec` would reach a bash repo hook and silently skip it. The
 * scrub keys on behaviour, not the interpreter's path, and not on BASH_VERSION, which the agent could
 * set. `command` stops the readonly error from ending a bash-as-sh script.
 */
declare const ENVIRONMENT_SCRUB = "command unset SHELLOPTS 2>/dev/null\n";
/** The `HookShell` the hooks writer takes, for `shell` (the probed interpreter by default). */
declare const hookShell: (shell?: string) => HookShell;

/** Resolves a bare specifier to a file URL, the way `import` would from this module. */
type Resolve = (specifier: string) => string;
/**
 * The caller's own scanner dir and the node running it, so a caller whose PATH lacks the scanner
 * still scans (CC-461). A scanner that cannot be resolved, or whose bin link points elsewhere, is
 * left out and the hook falls back to the caller's PATH alone.
 */
declare function ownToolDirs(resolve?: Resolve): string[];
/** Appends each absolute dir not already on the PATH, so a scanner the owner installed still wins. */
declare function withOwnTools(brokerPath: string, dirs: readonly string[]): string;
/** The caller's absolute PATH plus its own scanner and node, the owner's passwd home, and the default terms policy. */
declare const defaultScanInputs: () => ScanInputs;

/**
 * `<git-bin>/core`: the exec-path agents run git with (TP-4249). git puts its exec-path first on the
 * PATH of every shell it starts, so there `git` and `git-<builtin>` are the push shim. It sits under
 * the shim dir, so the pre-push hook drops it from its scan PATH with the shim.
 */
declare const gitMirrorDirFor: (shimDir: string) => string;
/** An inherited GIT_EXEC_PATH would make a probe read the mirror back and mirror itself. */
declare function probeGit(real: string, args: readonly string[]): string;
/** Each mirror entry's link target: the shim for `git` and every dashed builtin, the real entry otherwise. */
declare function mirrorEntries(listing: readonly string[], builtins: readonly string[], core: string, shim: string): Map<string, string>;
/**
 * Builds the mirror of the real `core` for the shim in `shimDir` and returns its stable path, or
 * '' when git's version or core cannot be read. Then the link is removed, so the shim and the
 * launcher both leave the exec-path alone rather than point git at a stale mirror.
 */
declare function writeGitMirror(shimDir: string, real: string, core: string, builtins: readonly string[]): string;

/** git's rule for a config variable name, so any other word cannot be an alias. */
declare const ALIAS_NAME: RegExp;
/** Names the dir holding the agent's `git` shim in the launch plan; `run-agent` puts it first on PATH. */
declare const GIT_SHIM_DIR_ENV = "AGENT_CHAT_GIT_SHIM_DIR";
/** `<home>/git-bin`, beside the guard's `<home>/git-hooks`, so the pure plan builder needs no extra input. */
declare const gitShimDirFor: (hooksDir: string) => string;
/** The config-file locations the agent starts with, baked so one call cannot swap them. */
interface SpawnConfigHome {
    HOME?: string;
    XDG_CONFIG_HOME?: string;
}
/**
 * The agent's `git`: a push, found after global options or through `alias.<word>`, is refused when
 * it skips verification or when the hooks path git resolves is not the guard's. A shell (`!`)
 * alias runs only when its name is in `shellAliases` (CC-613). Everything else execs the real
 * git, baked as an absolute path so the shim never finds itself.
 */
declare const gitShimScript: (real: string, guard: string, builtins: readonly string[], execPath?: string, shell?: string, shellAliases?: readonly string[], spawnHome?: SpawnConfigHome, mirror?: string) => string;
declare const realpathOr: (file: string) => string;
declare const isExecutableFile: (file: string) => boolean;
/**
 * The first `git` on PATH that is not an agent-chat shim, this one or any other (CC-1653: another
 * shim baked as the real git runs its own guard's checks against this shim's hooks dir). Kept
 * unresolved so a package upgrade does not strand it.
 */
declare function findRealGit(pathValue: string, shimDir: string): string | undefined;
/** Rewritten through a rename, so a git call at that moment never execs a half-written file. */
declare function writeGitShim(dir: string, guard: string, pathValue?: string, shellAliases?: readonly string[], spawnHome?: SpawnConfigHome): boolean;

/** Starts the second line of every script agent-chat puts on an agent's PATH. */
declare const SHIM_HEADER = "# Written by agent-chat";
/**
 * CC-1653: true when `file`, through any symlink, is a script agent-chat wrote. Keyed on content, not
 * on where the file sits, so a shim under a relocated home, a mirror link or a test fixture counts too.
 * sh must read a script to run it, so a file this cannot read is not a shim.
 */
declare function isAgentChatShim(file: string): boolean;
/** A PATH entry holding an agent-chat `git` or `gh` shim. */
declare const holdsAgentChatShim: (dir: string) => boolean;

export { ALIAS_NAME, type Bake, CHAINED_HOOKS, ENVIRONMENT_SCRUB, GIT_SHIM_DIR_ENV, type HookSetup, type HookShell, MISSING_TERMS_REFUSES, type PrePushPlan, type Resolve, SHIM_HEADER, STAMP_FILE, type ScanInputs, type ScanVerdict, type ScannerFacts, type SpawnConfigHome, defaultScanInputs, findRealGit, gitHooksEnv, gitMirrorDirFor, gitShimDirFor, gitShimScript, hardenedShebang, holdsAgentChatShim, hookScripts, hookShell, hooksDirOf, isAgentChatShim, isExecutableFile, isNoRewriteHooksDir, mirrorEntries, noRewriteHooksDir, ownToolDirs, passwdHome, posixShell, prePushScript, probeGit, probeScanner, realpathOr, termsFileFor, withOwnTools, writeGitHooks, writeGitMirror, writeGitShim };
