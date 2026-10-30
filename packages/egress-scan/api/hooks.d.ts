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
    /** The broker's own PATH, absolute entries only; the hook never uses the agent's PATH. */
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
 */
declare const noRewriteHooksDir: (hooksDir: string) => string;
/** The dir's name carries the policy, so a plan that selected it rewrites it the same way on resume. */
declare const isNoRewriteHooksDir: (dir: string) => boolean;
/** Writes the hooks into `dir`; a dir named by `noRewriteHooksDir` also gets the no-rewrite push policy. */
declare function writeGitHooks(dir: string, inputs: ScanInputs, setup: HookSetup): void;
/** Not a hook name, so git never runs it; only its mtime is read. */
declare const STAMP_FILE = "egress-scan.stamp";

export { type Bake, CHAINED_HOOKS, type HookSetup, type HookShell, MISSING_TERMS_REFUSES, type PrePushPlan, STAMP_FILE, type ScanInputs, type ScanVerdict, type ScannerFacts, gitHooksEnv, hookScripts, hooksDirOf, isNoRewriteHooksDir, noRewriteHooksDir, passwdHome, prePushScript, probeScanner, termsFileFor, writeGitHooks };
