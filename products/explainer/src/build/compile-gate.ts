import { build, type Plugin } from "esbuild";
import { z } from "zod";

/** The only modules a custom layer may import: React and the react-ui motion primitives the page provides. */
export const LAYER_IMPORT_ALLOWLIST: readonly string[] = ["react", "react/jsx-runtime", "@titan-design/react-ui/motion"];

export type CompileVerdict = { ok: true } | { ok: false; error: string };

// Every import, static, dynamic or require, reaches onResolve; an allowed one stays external, any other is refused.
const allowlistPlugin = (allowed: readonly string[]): Plugin => ({
  name: "layer-import-allowlist",
  setup(setup) {
    setup.onResolve({ filter: /.*/ }, ({ path }) =>
      allowed.includes(path) ? { path, external: true } : { errors: [{ text: `import "${path}" is not allowed in a custom layer (allowed: ${allowed.join(", ")})` }] });
  },
});

/**
 * Whether a built layer's TSX compiles and imports only allowlisted modules. Bundling, not a bare transform, so every
 * import goes through the allowlist; nothing is written.
 */
export async function compileLayer(module: string, allowed: readonly string[] = LAYER_IMPORT_ALLOWLIST): Promise<CompileVerdict> {
  try {
    await build({
      stdin: { contents: module, loader: "tsx", sourcefile: "layer.tsx" },
      bundle: true, write: false, format: "esm", jsx: "automatic", logLevel: "silent", plugins: [allowlistPlugin(allowed)],
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: compileError(error) };
  }
}

const BuildFailureSchema = z.object({
  errors: z.array(z.object({ text: z.string(), location: z.object({ line: z.number(), column: z.number() }).nullish() })).min(1),
});

function compileError(error: unknown): string {
  const failure = BuildFailureSchema.safeParse(error);
  if (!failure.success) return error instanceof Error ? error.message : String(error);
  return failure.data.errors.map(({ text, location }) => (location ? `layer.tsx:${location.line}:${location.column}: ${text}` : text)).join("; ");
}
