#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { AtlasError, build, context, inventory, json, propose, safePath } from "./engine.ts";
import { init } from "./install.ts";
import { check, installed, load, refresh } from "./store.ts";

const COMMAND = {
  help: "help",
  init: "init",
  check: "check",
  refresh: "refresh",
  scan: "scan",
  context: "context",
  query: "query",
} as const;
const OPTION = { root: "--root", config: "--config", domain: "--domain", seed: "--seed" } as const;
const COMMANDS = [
  COMMAND.init,
  COMMAND.check,
  COMMAND.refresh,
  COMMAND.scan,
  COMMAND.context,
  COMMAND.query,
];

export function args(argv: string[]) {
  const [command = COMMAND.help, ...rest] = argv;
  let root = process.cwd();
  let config: string | undefined;
  const domains: string[] = [];
  const seeds: string[] = [];

  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];

    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === OPTION.root) root = realpathSync(value);
    else if (key === OPTION.config) config = value;
    else if (key === OPTION.domain) domains.push(value);
    else if (key === OPTION.seed) seeds.push(value);
    else throw new Error(`Unknown option: ${key}`);
  }

  return { command, root: realpathSync(root), config, scope: { domains, seeds } };
}

export async function main(argv = process.argv.slice(2)) {
  const a = args(argv);

  if (a.command === COMMAND.help || a.command === "--help")
    return "agent-atlas init|check|refresh|scan|context|query [--root DIR] [--config RULES.json] [--domain NAME | --seed FILE]\ninit: optional explicit --config; check/context/query/scan are read-only; refresh never changes human rules.";

  if (!COMMANDS.some((command) => command === a.command))
    throw new Error(`Unknown command: ${a.command}`);

  if (a.config && a.command !== COMMAND.init && a.command !== COMMAND.scan)
    throw new Error(
      "--config is only accepted by init/scan; installed rules are .agent-atlas/rules.json",
    );
  const input = a.config ? JSON.parse(readFileSync(safePath(a.root, a.config), "utf8")) : undefined;

  if (a.command === COMMAND.init) {
    const r = await init(a.root, input);
    return `${r.changed ? "Installed" : "Already installed (unchanged)"}. ${r.snapshot.nodes.length} graph nodes. Start Pi at this root or /reload.\nCoverage:\n${r.snapshot.coverage.join("\n") || "No known unsupported constructs found; static JS/TS only."}`;
  }

  if (a.command === COMMAND.refresh) {
    const r = refresh(a.root);
    return `${r.changed ? "Refreshed" : "Already fresh"}. ${r.snapshot.nodes.length} nodes.\n${r.snapshot.coverage.join("\n")}`;
  }

  if (a.command === COMMAND.check) {
    const r = check(a.root);

    if (!r.fresh) throw new Error("Atlas is stale; run refresh. No files written.");

    return `Fresh: ${r.snapshot.inputHash}\n${r.snapshot.coverage.join("\n")}`;
  }

  if (a.command === COMMAND.scan) {
    const state = installed(a.root) ? load(a.root) : undefined;
    return json(
      build(a.root, input ?? state?.rules ?? propose(inventory(a.root)), state?.snapshot),
    );
  }

  if (installed(a.root)) {
    const r = check(a.root);

    if (!r.fresh)
      throw new Error("Atlas is stale; run refresh. Read-only context never refreshes implicitly.");
    return context(r.snapshot, a.scope);
  }

  return context(build(a.root, input ?? propose(inventory(a.root))), a.scope);
}

if (import.meta.main) {
  main()
    .then((output) => console.log(output))
    .catch((e) => {
      (e instanceof AtlasError ? console.log : console.error)(String(e.message ?? e));
      process.exitCode = 1;
    });
}
