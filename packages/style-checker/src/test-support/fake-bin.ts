import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface FakeBin {
  dir: string;
  install(name: string, script: string): void;
  onPathOnly(): void;
  onPathFirst(): void;
  restore(): void;
}

export function createFakeBin(): FakeBin {
  const dir = mkdtempSync(join(tmpdir(), "style-checker-fake-bin-"));
  const originalPath = process.env.PATH;
  return {
    dir,
    install(name, script) {
      const path = join(dir, name);
      writeFileSync(path, `#!/bin/sh\n${script}\n`, "utf-8");
      chmodSync(path, 0o755);
    },
    onPathOnly() {
      process.env.PATH = dir;
    },
    onPathFirst() {
      process.env.PATH = `${dir}:${originalPath ?? ""}`;
    },
    restore() {
      process.env.PATH = originalPath;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A shell fragment that prints `text` exactly, for a fake tool's stdout or stderr. */
export function heredoc(text: string, stream: "stdout" | "stderr" = "stdout"): string {
  const redirect = stream === "stderr" ? " >&2" : "";
  return `cat <<'FAKE_EOF'${redirect}\n${text}\nFAKE_EOF`;
}
