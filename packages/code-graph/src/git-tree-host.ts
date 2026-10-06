import type { FileSystemHost, RuntimeDirEntry } from "ts-morph";

function readOnly(): never {
  throw new Error("a git tree source is read-only");
}

/** One answer per path, shared by the IndexSource methods and the ts-morph host so they always agree. */
export interface TreeAnswers {
  fileExists(abs: string): boolean;
  readFile(abs: string): string;
  directoryExists(abs: string): boolean;
  readDir(abs: string): RuntimeDirEntry[];
  realpath(abs: string): string;
}

/** A read-only ts-morph host over a git tree source's answers. */
export function overlayHost(answers: TreeAnswers, real: FileSystemHost): FileSystemHost {
  return {
    isCaseSensitive: () => real.isCaseSensitive(),
    readDirSync: answers.readDir,
    readFileSync: (p) => answers.readFile(p),
    readFile: async (p) => answers.readFile(p),
    fileExistsSync: answers.fileExists,
    fileExists: async (p) => answers.fileExists(p),
    directoryExistsSync: answers.directoryExists,
    directoryExists: async (p) => answers.directoryExists(p),
    realpathSync: answers.realpath,
    getCurrentDirectory: () => real.getCurrentDirectory(),
    glob: () => Promise.reject(new Error("glob is not supported on a git tree source")),
    globSync: () => readOnly(),
    delete: async () => readOnly(),
    deleteSync: readOnly,
    writeFile: async () => readOnly(),
    writeFileSync: readOnly,
    mkdir: async () => readOnly(),
    mkdirSync: readOnly,
    move: async () => readOnly(),
    moveSync: readOnly,
    copy: async () => readOnly(),
    copySync: readOnly,
  };
}
