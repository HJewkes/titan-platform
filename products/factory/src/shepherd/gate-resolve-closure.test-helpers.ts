import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { z } from "zod";

/**
 * A resolve sink (TP-4052): the declaration a gate answer must reach, and which argument says who answered. A call into
 * it, an implementation of it, or a function that forwards its own parameter into that argument decides who resolves.
 */
interface SinkAnchor {
  pkg: string;
  container?: string;
  member: string;
  slot: number;
}

const SINK_ANCHORS: SinkAnchor[] = [
  { pkg: "packages/hitl", container: "GateStore", member: "resolve", slot: 2 },
  { pkg: "packages/hitl", member: "resolveGate", slot: 3 },
  { pkg: "packages/workflow", container: "WorkflowRuntime", member: "signal", slot: 3 },
  { pkg: "packages/queue-mirror", container: "QueueSource", member: "resolve", slot: 1 },
  { pkg: "packages/owner-queue", container: "QueueSource", member: "resolve", slot: 1 },
];
const RESOLVER_TYPE = { pkg: "packages/hitl", name: "GateResolver" };

const TOPS = ["packages", "products", "apps"];
const SKIPPED_DIRS = new Set(["node_modules", "dist", "coverage", "fixtures", "test-support"]);
const SOURCE = /\.(ts|tsx|mts|cts)$/;
const NOT_SOURCE = /(\.(test|d)\.[a-z]+|\.test-helpers\.ts|test-fixture\.ts)$/;

export const COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  jsx: ts.JsxEmit.ReactJSX,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
  allowImportingTsExtensions: true,
  resolveJsonModule: true,
  noUncheckedIndexedAccess: true,
};

function walkSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith(".") || SKIPPED_DIRS.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walkSources(path);
    return SOURCE.test(entry.name) && !NOT_SOURCE.test(entry.name) ? [path] : [];
  });
}

/** Every non-test source file the closure scans under one unit's directory, as absolute paths. */
const repoSources = (root: string, dir: string): string[] => walkSources(join(root, dir));

/** `packages/hitl` for any file under it, src or dist, so a declaration and its built `.d.ts` share one key. */
function unitOf(root: string, fileName: string): string | undefined {
  const parts = relative(root, fileName).split(sep);
  return parts.length > 2 && TOPS.includes(parts[0]!) ? `${parts[0]}/${parts[1]}` : undefined;
}

const hasName = (node: ts.Node): node is ts.Node & { readonly name?: ts.Node } => "name" in node;

function nameOf(node: ts.Node): string | undefined {
  const name = hasName(node) ? node.name : undefined;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined;
}

/** The class, interface or object declaration a member sits in, or undefined for a declaration that is no member. */
function ownerOf(node: ts.Node): ts.Node | undefined {
  const parent = node.parent;
  if (ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent)) return parent;
  if (ts.isObjectLiteralExpression(parent) || ts.isTypeLiteralNode(parent)) return parent.parent;
  return undefined;
}

const isTopLevel = (node: ts.Node): boolean => ts.isSourceFile(node.parent) || (ts.isVariableDeclaration(node) && ts.isSourceFile(node.parent.parent.parent));

/**
 * Who answers a gate, traced by the type checker over the repo (TP-4052): files that call, reference or implement a
 * resolve sink, forward a parameter into one, or build a `GateResolver` (a literal typed as one, or a function that
 * returns one, declared or referenced). The checker resolves receivers, destructuring, aliases and element access to
 * the declaration, so the spelling of a call does not decide whether it is found.
 */
export class GateResolveClosure {
  /** Each sink's key and the argument slots that say who answered; a forwarder can take that from several parameters. */
  private readonly sinks = new Map<string, Set<number>>(SINK_ANCHORS.map((anchor) => [`${anchor.pkg}#${anchor.container ? `${anchor.container}.` : ""}${anchor.member}`, new Set([anchor.slot])]));
  private program!: ts.Program;
  private checker!: ts.TypeChecker;
  private sinkInterfaces: { type: ts.Type; member: string; slot: number }[] = [];
  private factoryCache = new Map<ts.Symbol, boolean>();

  constructor(private readonly root: string) {}

  /**
   * Repo-relative paths of the scanned files that sit in the closure. Scan a unit after every unit it imports: an
   * exported forwarder found in one is also keyed by unit and name, so a later unit's call through the `.d.ts` matches.
   */
  scan(program: ts.Program, scanned: readonly string[]): string[] {
    this.program = program;
    this.checker = program.getTypeChecker();
    this.sinkInterfaces = [];
    this.factoryCache = new Map();
    const files = scanned.map((path) => program.getSourceFile(path)).filter((file): file is ts.SourceFile => file !== undefined);
    this.anchorSinkInterfaces();
    this.addImplementers(program.getSourceFiles());
    this.addForwarders(files);
    return files.filter((file) => this.touches(file)).map((file) => relative(this.root, file.fileName).split(sep).join("/"));
  }

  /**
   * A declaration in a built `.d.ts` keys by unit and name, the only identity it shares with its source. A source
   * declaration keys by its file and name when exported, else by position, so two helpers that share a name stay apart.
   */
  private keyOf(decl: ts.Node): string | undefined {
    const file = decl.getSourceFile();
    const unitKey = this.unitKeyOf(decl);
    if (file.isDeclarationFile || unitKey === undefined) return unitKey;
    const owner = ownerOf(decl);
    return this.isExported(owner ?? decl) ? `${file.fileName}#${owner ? `${nameOf(owner)}.` : ""}${nameOf(decl)}` : `${file.fileName}:${decl.getStart()}`;
  }

  private unitKeyOf(decl: ts.Node): string | undefined {
    const unit = unitOf(this.root, decl.getSourceFile().fileName);
    const name = nameOf(decl);
    if (!unit || !name) return undefined;
    const owner = ownerOf(decl);
    return `${unit}#${owner ? `${nameOf(owner)}.` : ""}${name}`;
  }

  /** Records a sink under its own key, and an exported one also under the key a later unit's `.d.ts` call lands on. */
  private addSink(decl: ts.Node, slot: number): boolean {
    const own = this.keyOf(decl);
    const exported = this.isExported(ownerOf(decl) ?? decl) ? this.unitKeyOf(decl) : undefined;
    return [own, exported].reduce((grew, key) => (key === undefined ? grew : this.addSlot(key, slot) || grew), false);
  }

  private isExported(decl: ts.Node): boolean {
    const name = nameOf(decl);
    if (!name || !isTopLevel(decl)) return false;
    const file = decl.getSourceFile();
    if (file.isDeclarationFile) return true;
    const module = this.checker.getSymbolAtLocation(file);
    return module !== undefined && this.checker.getExportsOfModule(module).some((symbol) => symbol.name === name);
  }

  private anchorSinkInterfaces(): void {
    for (const file of this.program.getSourceFiles()) {
      if (unitOf(this.root, file.fileName) === undefined) continue;
      ts.forEachChild(file, (node) => this.collectSinkInterface(node));
    }
  }

  /** Finds each anchor's declaration in this program, so its own source keys as a sink as well as its `.d.ts`. */
  private collectSinkInterface(node: ts.Node): void {
    const unit = unitOf(this.root, node.getSourceFile().fileName);
    if (ts.isFunctionDeclaration(node)) {
      const anchor = SINK_ANCHORS.find((a) => a.pkg === unit && !a.container && a.member === nameOf(node));
      if (anchor) this.addSink(node, anchor.slot);
    }
    if (!ts.isInterfaceDeclaration(node) && !ts.isClassDeclaration(node)) return;
    const anchor = SINK_ANCHORS.find((a) => a.pkg === unit && a.container === nameOf(node));
    const symbol = node.name && this.checker.getSymbolAtLocation(node.name);
    if (!anchor || !symbol) return;
    this.sinkInterfaces.push({ type: this.checker.getDeclaredTypeOfSymbol(symbol), member: anchor.member, slot: anchor.slot });
    const members: readonly ts.Node[] = node.members;
    members.filter((member) => nameOf(member) === anchor.member).forEach((member) => this.addSink(member, anchor.slot));
  }

  /** A class or object that satisfies a sink interface makes its own member a sink too: calls on it reach the store. */
  private addImplementers(files: readonly ts.SourceFile[]): void {
    for (const file of files) {
      if (unitOf(this.root, file.fileName) === undefined) continue;
      const visit = (node: ts.Node): void => {
        for (const member of this.implementedMembers(node)) {
          this.addSink(member.decl, member.slot);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }

  private implementedMembers(node: ts.Node): { decl: ts.Node; slot: number }[] {
    const type = this.implementerType(node);
    if (!type) return [];
    return this.sinkInterfaces.flatMap((sink) => {
      if (!this.checker.isTypeAssignableTo(type, sink.type)) return [];
      const decl = type.getProperty(sink.member)?.declarations?.find((d) => d.getSourceFile() === node.getSourceFile());
      return decl ? [{ decl, slot: sink.slot }] : [];
    });
  }

  private implementerType(node: ts.Node): ts.Type | undefined {
    if (ts.isClassLike(node)) return this.checker.getTypeAtLocation(node);
    if (!ts.isObjectLiteralExpression(node) || !node.properties.some((p) => this.sinkInterfaces.some((s) => nameOf(p) === s.member))) return undefined;
    return this.checker.getTypeAtLocation(node);
  }

  /** A function that passes its own parameter into a sink's who-answered slot is a sink to its callers. */
  private addForwarders(files: readonly ts.SourceFile[]): void {
    let grew = true;
    while (grew) {
      grew = false;
      for (const file of files) {
        const visit = (node: ts.Node): void => {
          if (ts.isCallExpression(node) && this.addForwarder(node)) grew = true;
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
    }
  }

  /** True when the set grew, so the fixpoint runs again. */
  private addSlot(key: string, slot: number): boolean {
    const slots = this.sinks.get(key) ?? new Set<number>();
    if (slots.has(slot)) return false;
    this.sinks.set(key, slots.add(slot));
    return true;
  }

  private addForwarder(call: ts.CallExpression): boolean {
    const fn = ts.findAncestor(call.parent, ts.isFunctionLike);
    if (!fn) return false;
    const callee = this.calleeDeclarationOf(fn);
    let grew = false;
    for (const slot of this.sinkSlotsOf(call.expression)) {
      const arg = call.arguments[slot];
      for (const param of arg ? this.parameterIndicesIn(arg, fn) : []) grew = this.addSink(callee, param) || grew;
    }
    return grew;
  }

  private sinkSlotsOf(callee: ts.Expression): number[] {
    return this.declarationsAt(callee).flatMap((decl) => {
      const key = this.keyOf(decl);
      return key ? [...(this.sinks.get(key) ?? [])] : [];
    });
  }

  /** The indices of the parameters of `fn` that `arg` reads. */
  private parameterIndicesIn(arg: ts.Node, fn: ts.SignatureDeclaration): number[] {
    const found = new Set<number>();
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        const decl = this.checker.getSymbolAtLocation(node)?.valueDeclaration;
        const param = decl && ts.findAncestor(decl, ts.isParameter);
        if (param && param.parent === fn) found.add(fn.parameters.indexOf(param));
      }
      ts.forEachChild(node, visit);
    };
    visit(arg);
    return [...found];
  }

  /** The declaration a caller's symbol lands on: the function itself, or the variable or property holding it. */
  private calleeDeclarationOf(fn: ts.SignatureDeclaration): ts.Node {
    const parent = fn.parent;
    if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && (ts.isVariableDeclaration(parent) || ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent))) return parent;
    return fn;
  }

  private declarationsAt(node: ts.Node): ts.Declaration[] {
    const symbol = this.symbolAt(node);
    if (!symbol) return [];
    const target = symbol.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(symbol) : symbol;
    return target.declarations ?? [];
  }

  /** The symbol a node names, with a destructured binding read through to the property it takes. */
  private symbolAt(node: ts.Node): ts.Symbol | undefined {
    const parent = node.parent;
    if (ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent) && (parent.propertyName ?? parent.name) === node) {
      const property = parent.propertyName ?? parent.name;
      const name = ts.isIdentifier(property) || ts.isStringLiteral(property) ? property.text : undefined;
      return name ? this.checker.getTypeAtLocation(parent.parent).getProperty(name) : undefined;
    }
    return this.checker.getSymbolAtLocation(node);
  }

  private touches(file: ts.SourceFile): boolean {
    let hit = false;
    const visit = (node: ts.Node): void => {
      if (hit) return;
      hit = this.isResolveSite(node);
      if (!hit) ts.forEachChild(node, visit);
    };
    visit(file);
    return hit;
  }

  private isResolveSite(node: ts.Node): boolean {
    if (ts.isObjectLiteralExpression(node)) return this.isResolverType(this.checker.getContextualType(node));
    if (ts.isFunctionLike(node) && !ts.isFunctionTypeNode(node)) return this.returnsResolver(this.checker.getSignatureFromDeclaration(node));
    if (!ts.isIdentifier(node) && !ts.isStringLiteral(node) && !ts.isPrivateIdentifier(node)) return false;
    return this.declarationsAt(node).some((decl) => {
      const key = this.keyOf(decl);
      return (key !== undefined && this.sinks.has(key)) || this.isFactory(decl);
    });
  }

  private isFactory(decl: ts.Declaration): boolean {
    const name = ts.getNameOfDeclaration(decl);
    const symbol = name && this.checker.getSymbolAtLocation(name);
    if (!symbol || ts.isParameter(decl)) return false;
    const cached = this.factoryCache.get(symbol);
    if (cached !== undefined) return cached;
    const signatures = this.checker.getTypeOfSymbolAtLocation(symbol, decl).getCallSignatures();
    const result = signatures.some((signature) => this.returnsResolver(signature));
    this.factoryCache.set(symbol, result);
    return result;
  }

  private returnsResolver(signature: ts.Signature | undefined): boolean {
    return signature !== undefined && this.isResolverType(this.checker.getReturnTypeOfSignature(signature));
  }

  private isResolverType(type: ts.Type | undefined): boolean {
    if (!type) return false;
    const parts = type.isUnion() ? type.types : [type];
    return parts.some((part) => {
      const decl = (part.aliasSymbol ?? part.getSymbol())?.declarations?.[0];
      return decl !== undefined && nameOf(decl) === RESOLVER_TYPE.name && unitOf(this.root, decl.getSourceFile().fileName) === RESOLVER_TYPE.pkg;
    });
  }
}

export function sourceProgram(roots: readonly string[], host?: ts.CompilerHost): ts.Program {
  return ts.createProgram({ rootNames: roots, options: COMPILER_OPTIONS, host });
}

const DependencyMap = z.record(z.string(), z.string()).optional();
const ManifestSchema = z.object({ name: z.string(), dependencies: DependencyMap, devDependencies: DependencyMap, peerDependencies: DependencyMap });

interface Unit {
  dir: string;
  deps: string[];
}

function readUnit(root: string, dir: string): [string, Unit] | undefined {
  const manifest = join(root, dir, "package.json");
  if (!existsSync(manifest)) return undefined;
  const pkg = ManifestSchema.parse(JSON.parse(readFileSync(manifest, "utf8")));
  const deps = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies].flatMap((group) => Object.keys(group ?? {}));
  return [pkg.name, { dir, deps }];
}

const SINK_UNITS = new Set([...SINK_ANCHORS.map((anchor) => anchor.pkg), RESOLVER_TYPE.pkg]);

/**
 * Each package, product and app directory that can name a sink, every one after the workspace units it depends on. A
 * unit whose dependency closure misses every sink unit cannot import a sink's type, so the checker would find nothing.
 */
function unitsInOrder(root: string): string[] {
  const units = new Map(TOPS.flatMap((top) => readdirSync(join(root, top)).map((name) => readUnit(root, `${top}/${name}`))).filter((unit) => unit !== undefined));
  const ordered: string[] = [];
  const reach = new Map<string, boolean>();
  const visit = (name: string): boolean => {
    const unit = units.get(name);
    if (!unit) return false;
    const known = reach.get(name);
    if (known !== undefined) return known;
    reach.set(name, false);
    const reaches = unit.deps.map(visit).some(Boolean) || SINK_UNITS.has(unit.dir);
    reach.set(name, reaches);
    if (reaches) ordered.push(unit.dir);
    return reaches;
  };
  [...units.keys()].forEach(visit);
  return ordered;
}

/** Parses each `.d.ts` once for every unit's program: the lib and dependency declarations they all load are the bulk of the work. */
function declarationCachingHost(): ts.CompilerHost {
  const host = ts.createCompilerHost(COMPILER_OPTIONS);
  const { getSourceFile } = host;
  const parsed = new Map<string, ts.SourceFile | undefined>();
  host.getSourceFile = (name, version, ...rest) => {
    if (!name.endsWith(".d.ts")) return getSourceFile(name, version, ...rest);
    if (!parsed.has(name)) parsed.set(name, getSourceFile(name, version, ...rest));
    return parsed.get(name);
  };
  return host;
}

/** The closure of every non-test source file in the repo, one program per unit so no checker holds the whole tree. */
export function repoClosure(root: string): string[] {
  const closure = new GateResolveClosure(root);
  const host = declarationCachingHost();
  return unitsInOrder(root).flatMap((dir) => {
    const sources = repoSources(root, dir);
    return sources.length === 0 ? [] : closure.scan(sourceProgram(sources, host), sources);
  });
}
