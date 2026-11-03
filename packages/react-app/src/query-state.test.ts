import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PROBE = join(dirname(fileURLToPath(import.meta.url)), "query-state.probe.ts");
const COMPILE_TIMEOUT_MS = 60_000;

/** Vitest strips types, so the state's type contract is only observable by compiling against it. */
function compileErrors(stateLiteral: string): string[] {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    types: [],
  };
  const source = [
    'import { RpcError } from "@titan-design/rpc-client";',
    'import type { QueryState } from "./hooks/query-store.js";',
    `export const state: QueryState = ${stateLiteral};`,
  ].join("\n");
  const host = ts.createCompilerHost(options);
  const readSource = host.getSourceFile.bind(host);
  host.getSourceFile = (file, version, ...rest) =>
    file === PROBE ? ts.createSourceFile(file, source, version) : readSource(file, version, ...rest);
  const program = ts.createProgram([PROBE], options, host);
  return ts.getPreEmitDiagnostics(program).map(({ code, messageText }) => `TS${code}: ${ts.flattenDiagnosticMessageText(messageText, "\n")}`);
}

describe("QueryState", () => {
  it(
    "compiles an error state that holds an error object",
    () => {
      const literal = '{ status: "error", data: undefined, error: new RpcError("note.get", "boom", 1), isFetching: false }';

      expect(compileErrors(literal)).toEqual([]);
    },
    COMPILE_TIMEOUT_MS,
  );

  it(
    "refuses an error state with no error object",
    () => {
      const literal = '{ status: "error", data: undefined, error: undefined, isFetching: false }';

      expect(compileErrors(literal)).toEqual([expect.stringMatching(/^TS2322: /)]);
    },
    COMPILE_TIMEOUT_MS,
  );
});
