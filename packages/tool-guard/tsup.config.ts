import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts", "shell/index": "src/shell/index.ts", bin: "src/bin.ts", deadline: "src/deadline.ts", "hook-worker": "src/hook-worker.ts", "merge-lint/index": "src/merge-lint/index.ts", "merge-lint-bin": "src/merge-lint/merge-lint-bin.ts" },
  format: ["esm"],
  dts: { entry: { index: "src/index.ts", "shell/index": "src/shell/index.ts", "merge-lint/index": "src/merge-lint/index.ts" } },
  clean: true,
  sourcemap: true,
});
