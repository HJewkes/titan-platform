export type { HookSetup } from "./dir.js";
export {
  CHAINED_HOOKS,
  gitHooksEnv,
  hookScripts,
  hooksDirOf,
  isNoRewriteHooksDir,
  noRewriteHooksDir,
  passwdHome,
  probeScanner,
  STAMP_FILE,
  writeGitHooks,
} from "./dir.js";
export type { Bake, HookShell, PrePushPlan, ScanInputs, ScannerFacts, ScanVerdict } from "./pre-push.js";
export { MISSING_TERMS_REFUSES, prePushScript, termsFileFor } from "./pre-push.js";
export { ENVIRONMENT_SCRUB, hardenedShebang, hookShell, posixShell } from "./posix-shell.js";
export { defaultScanInputs, ownToolDirs, withOwnTools, type Resolve } from "./scan-path.js";
export { gitMirrorDirFor, mirrorEntries, probeGit, writeGitMirror } from "./git-mirror.js";
export {
  ALIAS_NAME,
  findRealGit,
  GIT_SHIM_DIR_ENV,
  gitShimDirFor,
  gitShimScript,
  isExecutableFile,
  realpathOr,
  writeGitShim,
  type SpawnConfigHome,
} from "./git-shim.js";
export { holdsAgentChatShim, isAgentChatShim, SHIM_HEADER } from "./shim-header.js";
