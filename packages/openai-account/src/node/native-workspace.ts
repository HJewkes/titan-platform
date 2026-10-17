import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export interface NativeQuotaWorkspace { cwd: string; dispose(): Promise<void> }
interface WorkspaceFileSystem {
  realpath(path: string): Promise<string>;
  lstat(path: string): Promise<{ isDirectory(): boolean }>;
}
const failure = (): Error => new Error("native quota workspace unsafe");
async function absent(path: string, fs: WorkspaceFileSystem): Promise<boolean> {
  try { await fs.lstat(path); return false; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    throw failure();
  }
}
/** Metadata only. Configured markers cannot load ancestor project layers without .codex; .git can link external hooks. */
export async function assertProjectlessWorkspace(cwd: string, fs: WorkspaceFileSystem = { realpath, lstat }): Promise<string> {
  try {
    const canonical = await fs.realpath(cwd);
    if (!isAbsolute(canonical) || !(await fs.lstat(canonical)).isDirectory()) throw failure();
    let directory = canonical;
    for (let depth = 0; depth < 256; depth++) {
      if (!(await absent(join(directory, ".git"), fs)) || !(await absent(join(directory, ".codex"), fs))) throw failure();
      const parent = dirname(directory);
      if (parent === directory) return canonical;
      directory = parent;
    }
    throw failure();
  } catch { throw failure(); }
}
/** Empty alone is insufficient: TMPDIR can be inside a project. Validate physical ancestry before native startup. */
export async function createNativeQuotaWorkspace(): Promise<NativeQuotaWorkspace> {
  const created = await mkdtemp(join(tmpdir(), "openai-account-native-"));
  try {
    const cwd = await assertProjectlessWorkspace(created);
    return { cwd, async dispose() { await rm(cwd, { recursive: true, force: true }); } };
  } catch {
    await rm(created, { recursive: true, force: true }).catch(() => {});
    throw failure();
  }
}
