import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, posix } from "node:path";
import { createHash } from "node:crypto";
import ts from "typescript";

export const IGNORED = [".git", "node_modules", ".pi", ".agent-atlas", ".agent-atlas.lock"];
export const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
export const json = (x: unknown) => JSON.stringify(x, null, 2) + "\n";
export type Domain = { name: string; paths: string[] };
export type Rules = { version: 1; domains: Domain[]; exclude: string[]; autoPackages?: { under: string; prefix: string }[] };
export type Snapshot = {
  version: 1; inputHash: string; rulesHash: string; packages: string[];
  domains: Domain[]; files: { path: string; domain: string | null; hash: string }[];
  nodes: string[]; adjacency: Record<string, string[]>;
  external: { from: string; specifier: string }[]; coverage: string[];
};
export class AtlasError extends Error {
  constructor(public issues: string[]) { super(issues.join("\n")); }
}
export function fail(message: string): never { throw new AtlasError([message]); }
export function cleanPath(p: unknown, allowRoot = true): string {
  if (typeof p !== "string" || !p || p.includes("\\") || /[\x00-\x1f\x7f]/.test(p) || isAbsolute(p) || p.split("/").some(x => x === ".." || x === "")) fail(`Unsafe repository path: ${String(p)}`);
  const n = posix.normalize(p);
  if ((!allowRoot && n === ".") || n !== p || p.endsWith("/")) fail(`Use normalized repository-relative paths: ${p}`);
  return n;
}
export const contains = (base: string, p: string) => base === "." || p === base || p.startsWith(base + "/");
export function safePath(root: string, p: string): string {
  cleanPath(p);
  let current = root;
  for (const part of p === "." ? [] : p.split("/")) {
    current = resolve(current, part);
    try { if (lstatSync(current).isSymbolicLink()) fail(`Symlink is not supported: ${p}`); }
    catch (e: any) { if (e.code !== "ENOENT") throw e; }
  }
  return resolve(root, p);
}
export function parseRules(input: unknown): Rules {
  const r = input as Rules;
  if (!r || r.version !== 1 || !Array.isArray(r.domains) || !Array.isArray(r.exclude) || Object.keys(r).some(k => !["version", "domains", "exclude", "autoPackages"].includes(k))) fail("Rules require version:1, domains:[], exclude:[]; optional autoPackages:[] only");
  const names = new Set<string>();
  const paths: string[] = [];
  for (const d of r.domains) {
    if (!d || typeof d.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(d.name) || names.has(d.name) || !Array.isArray(d.paths) || !d.paths.length || Object.keys(d).some(k => !["name", "paths"].includes(k))) fail("Domain names must be unique, nonempty simple identifiers; paths must be nonempty arrays");
    names.add(d.name);
    paths.push(...d.paths.map(p => cleanPath(p)));
  }
  paths.push(...r.exclude.map(p => cleanPath(p)));
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++) if (contains(paths[i]!, paths[j]!) || contains(paths[j]!, paths[i]!)) fail(`Overlapping ownership rules: ${paths[i]} and ${paths[j]}`);
  if (r.autoPackages !== undefined && !Array.isArray(r.autoPackages)) fail("autoPackages must be an array");
  const autos: string[] = [];
  for (const a of r.autoPackages ?? []) {
    if (!a || typeof a.prefix !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(a.prefix) || Object.keys(a).some(k => !["under", "prefix"].includes(k))) fail("Invalid autoPackages rule");
    cleanPath(a.under, false);
    for (const p of [...paths, ...autos]) if (contains(p, a.under) || contains(a.under, p)) fail(`Overlapping package-creation rule: ${a.under} and ${p}`);
    autos.push(a.under);
  }
  return r;
}
export function inventory(root: string): Map<string, Buffer> {
  root = realpathSync(root);
  const files = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const name of readdirSync(safePath(root, dir)).sort()) {
      if (IGNORED.includes(name)) continue;
      const p = dir === "." ? name : `${dir}/${name}`;
      cleanPath(p);
      const absolute = safePath(root, p), stat = lstatSync(absolute);
      if (stat.isDirectory()) walk(p);
      else if (stat.isFile()) {
        if (stat.size > 8 * 1024 * 1024) fail(`File exceeds v1 8 MiB scan limit: ${p}. Explicit exclusions still hash files; move build/dependency output outside the indexed tree.`);
        files.set(p, readFileSync(absolute));
      } else fail(`Unsupported filesystem entry: ${p}`);
    }
  };
  walk(".");
  return new Map([...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
export const inventoryHash = (files: Map<string, Buffer>) => hash(json([...files].map(([p, b]) => [p, hash(b)])));
const sourcePattern = /\.(?:[jt]sx?|[cm][jt]s)$/;
const unsupportedLanguage = /\.(?:py|rs|go|java|kt|c|h|cpp|cs|rb|php|swift|vue|svelte|astro|sh|sql|lua|ex|exs|scala|clj|dart|m|mm|ipynb)$/;
export function propose(files: Map<string, Buffer>): Rules {
  const packages = [...files.keys()].filter(p => p === "package.json" || p.endsWith("/package.json"));
  if (packages.length === 1 && packages[0] === "package.json") return { version: 1, domains: [{ name: "root", paths: ["."] }], exclude: [] };
  fail("No unambiguous single root package boundary. Zero files written. Supply --config rules.json, e.g. {\"version\":1,\"domains\":[{\"name\":\"app\",\"paths\":[\"src\"]}],\"exclude\":[\"README.md\"]}. Package boundaries found: " + (packages.join(", ") || "none"));
}
export function build(root: string, rulesInput: unknown, previous?: Snapshot): Snapshot {
  root = realpathSync(root);
  const rules = parseRules(rulesInput), data = inventory(root);
  const packages = [...data.keys()].filter(p => p === "package.json" || p.endsWith("/package.json"));
  const domains = rules.domains.map(d => ({ name: d.name, paths: [...d.paths].sort() }));
  for (const a of rules.autoPackages ?? []) {
    for (const p of packages) {
      const dir = posix.dirname(p);
      if (posix.dirname(dir) === a.under) {
        const name = a.prefix + posix.basename(dir);
        if (domains.some(d => d.name === name)) fail(`Auto package domain name conflict: ${name}`);
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(name)) fail(`Invalid auto package domain name: ${name}`);
        domains.push({ name, paths: [dir] });
      }
    }
  }
  domains.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const issues: string[] = [], coverage: string[] = [];
  const files = [...data].map(([path, bytes]) => {
    const matches = domains.filter(d => d.paths.some(p => contains(p, path)));
    const excluded = rules.exclude.some(p => contains(p, path));
    if (matches.length + Number(excluded) !== 1) issues.push(`Unassigned or conflicting path: ${path}. Declare a domain path or explicit exclusion.`);
    if (!excluded && !sourcePattern.test(path)) coverage.push(`${unsupportedLanguage.test(path) ? "Unsupported language (inventory only)" : "Inventory only (no dependency extraction)"}: ${path}`);
    return { path, domain: excluded ? null : matches[0]?.name ?? null, hash: hash(bytes) };
  });
  for (const p of packages) {
    const dir = posix.dirname(p);
    if (previous && !rules.exclude.some(base => contains(base, p)) && !previous.packages.includes(p) && !domains.some(d => d.paths.includes(dir))) issues.push(`New package boundary requires an explicit domain or preapproved autoPackages rule: ${p}`);
  }
  const nodes = files.filter(f => f.domain !== null && sourcePattern.test(f.path)).map(f => f.path);
  const nodeSet = new Set(nodes);
  const adjacency: Record<string, string[]> = Object.create(null), external: Snapshot["external"] = [];
  const configs = new Map<string, ts.CompilerOptions>();
  const usedConfigs = new Set<string>();
  for (const p of nodes) {
    let dir = posix.dirname(p);
    while (true) {
      const prefix = dir === "." ? "" : dir + "/";
      const candidate = [prefix + "tsconfig.json", prefix + "jsconfig.json"].find(c => data.has(c));
      if (candidate) { usedConfigs.add(candidate); break; }
      if (dir === ".") break;
      dir = posix.dirname(dir);
    }
  }
  for (const p of [...usedConfigs].sort()) {
    const parsed = ts.parseConfigFileTextToJson(p, data.get(p)!.toString());
    if (parsed.error) { issues.push(`Invalid config: ${p}`); continue; }
    const config = parsed.config;
    if (!config || typeof config !== "object" || Array.isArray(config)) { issues.push(`Invalid config object: ${p}`); continue; }
    if (config.extends || config.references) { issues.push(`Unsupported config extends/references: ${p}. v1 requires self-contained compilerOptions.`); continue; }
    const dir = posix.dirname(p), opts = config.compilerOptions ?? {};
    if (opts.moduleSuffixes || opts.rootDirs || opts.customConditions) issues.push(`Unsupported resolver options in ${p}: moduleSuffixes/rootDirs/customConditions`);
    const base = opts.baseUrl ?? ".";
    if (typeof base !== "string") { issues.push(`Invalid baseUrl: ${p}`); continue; }
    const baseAbs = resolve(root, dir, base);
    if (!contains(root, baseAbs)) { issues.push(`baseUrl escapes repository: ${p}`); continue; }
    if (opts.paths) {
      if (typeof opts.paths !== "object" || Array.isArray(opts.paths)) { issues.push(`Invalid paths in ${p}`); continue; }
      for (const [key, values] of Object.entries(opts.paths)) {
        if ((key.match(/\*/g) ?? []).length > 1 || !Array.isArray(values) || !values.length || values.some(v => typeof v !== "string" || !contains(root, resolve(baseAbs, v)))) issues.push(`Invalid/escaping alias ${key} in ${p}`);
      }
    }
    const converted = ts.convertCompilerOptionsFromJson({ allowJs: true, ...opts }, resolve(root, dir));
    if (converted.errors.length) issues.push(`Invalid compilerOptions in ${p}: ${converted.errors.map(e => ts.flattenDiagnosticMessageText(e.messageText, " ")).join("; ")}`);
    configs.set(dir, { ...converted.options, moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true, noDtsResolution: false });
  }
  const dirs = new Set([root]);
  for (const p of data.keys()) { let d = resolve(root, posix.dirname(p)); while (contains(root, d)) { dirs.add(d); if (d === root) break; d = resolve(d, ".."); } }
  const toRel = (p: string) => relative(root, p).split("\\").join("/");
  const host: ts.ModuleResolutionHost = {
    fileExists: p => contains(root, resolve(p)) && data.has(toRel(p)),
    readFile: p => contains(root, resolve(p)) ? data.get(toRel(p))?.toString() : undefined,
    directoryExists: p => dirs.has(resolve(p)), getCurrentDirectory: () => root,
    realpath: p => p,
  };
  const localPackages = packages.flatMap(p => {
    try { const name = JSON.parse(data.get(p)!.toString()).name; return typeof name === "string" ? [name] : []; }
    catch { if (!rules.exclude.some(base => contains(base, p))) issues.push(`Invalid package.json: ${p}`); return []; }
  });
  for (const p of nodes) {
    adjacency[p] = [];
    let dir = posix.dirname(p), options: ts.CompilerOptions | undefined;
    while (true) { if (configs.has(dir)) { options = configs.get(dir); break; } if (dir === ".") break; dir = posix.dirname(dir); }
    options ??= { moduleResolution: ts.ModuleResolutionKind.Bundler, module: ts.ModuleKind.ESNext, allowJs: true };
    const source = ts.createSourceFile(p, data.get(p)!.toString(), ts.ScriptTarget.Latest, true);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics: ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics.length) issues.push(`Syntax parse error: ${p}: ${diagnostics.map(e => ts.flattenDiagnosticMessageText(e.messageText, " ")).join("; ")}`);
    const imports: string[] = [];
    const visit = (node: ts.Node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) imports.push(node.moduleReference.expression.text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imports.push(node.argument.literal.text);
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) coverage.push(`Unindexed import.meta usage: ${p}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) coverage.push(`Unindexed ${node.expression.kind === ts.SyntaxKind.ImportKeyword ? "dynamic import" : "require call"}: ${p}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (source.referencedFiles.length || source.typeReferenceDirectives.length || source.libReferenceDirectives.length) coverage.push(`Unindexed triple-slash references: ${p}`);
    for (const specifier of [...new Set(imports)].sort()) {
      const alias = Object.keys(options.paths ?? {}).some(k => k.includes("*") ? specifier.startsWith(k.split("*")[0]!) && specifier.endsWith(k.split("*")[1]!) : k === specifier);
      const isLocal = specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("#") || alias || localPackages.some(n => specifier === n || specifier.startsWith(n + "/"));
      const result = ts.resolveModuleName(specifier, resolve(root, p), options, host).resolvedModule;
      if (result) {
        const target = toRel(result.resolvedFileName);
        if (!nodeSet.has(target)) issues.push(`Local import targets excluded/unsupported file: ${p} -> ${specifier} (${target})`);
        else adjacency[p]!.push(target);
      } else if (isLocal) issues.push(`Unresolved local import: ${p} -> ${specifier}`);
      else external.push({ from: p, specifier });
    }
    adjacency[p] = [...new Set(adjacency[p])].sort();
  }
  if (issues.length) throw new AtlasError(issues.sort());
  return { version: 1, inputHash: inventoryHash(data), rulesHash: hash(json(rules)), packages, domains, files, nodes, adjacency, external, coverage: [...new Set(coverage)].sort() };
}
export type Scope = { domains?: string[]; seeds?: string[] };
export function select(snapshot: Snapshot, scope: Scope): Set<string> {
  if (!scope.domains?.length && !scope.seeds?.length) fail("Select --domain NAME or --seed FILE; task text is never guessed");
  for (const d of scope.domains ?? []) if (!snapshot.domains.some(x => x.name === d)) fail(`Unknown domain: ${d}`);
  for (const p of scope.seeds ?? []) if (!snapshot.nodes.includes(cleanPath(p, false))) fail(`Unknown graph seed: ${p}`);
  const selected = new Set(snapshot.files.filter(f => f.domain && scope.domains?.includes(f.domain)).map(f => f.path));
  for (const seed of scope.seeds ?? []) {
    selected.add(seed);
    for (const target of snapshot.adjacency[seed] ?? []) selected.add(target);
    for (const [source, targets] of Object.entries(snapshot.adjacency)) if (targets.includes(seed)) selected.add(source);
  }
  return selected;
}
export function context(snapshot: Snapshot, scope: Scope, limit = 12000): string {
  const selected = select(snapshot, scope);
  const incoming = Object.entries(snapshot.adjacency).filter(([p, targets]) => !selected.has(p) && targets.some(t => selected.has(t))).map(([p, targets]) => `${p} -> ${targets.filter(t => selected.has(t)).join(", ")}`);
  const lines = ["Agent Atlas — explicit scope; navigation aid, NOT a security sandbox.", `Source hash: ${snapshot.inputHash}`, "Domain map:", ...snapshot.domains.map(d => `${d.name}: ${d.paths.join(", ")}`), "Scope files and outgoing adjacency:", ...[...selected].sort().map(p => `${p} -> ${(snapshot.adjacency[p] ?? []).join(", ") || "(none)"}`), "Incoming boundary edges (not automatically selected):", ...incoming, `Coverage: ${snapshot.coverage.length} inventory-only files/unindexed constructs; ${snapshot.external.length} nonlocal imports (not verified).`, ...snapshot.coverage];
  const output = lines.join("\n");
  return output.length <= limit ? output : output.slice(0, limit - 100) + "\n[Context truncated; use CLI context/query with narrower seeds. Enforcement retains full selection.]";
}
