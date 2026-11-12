#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { build, context, inventory, json, propose, safePath } from "./engine.ts";

export function args(argv: string[]) {
  const [command = "help", ...rest] = argv;
  let root = process.cwd(), config: string | undefined;
  const domains: string[] = [], seeds: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!value) throw new Error(`Missing value for ${key}`);
    if (key === "--root") root = realpathSync(value);
    else if (key === "--config") config = value;
    else if (key === "--domain") domains.push(value);
    else if (key === "--seed") seeds.push(value);
    else throw new Error(`Unknown option: ${key}`);
  }
  return { command, root: realpathSync(root), config, scope: { domains, seeds } };
}
export async function main(argv = process.argv.slice(2)) {
  const a = args(argv);
  if (a.command === "help" || a.command === "--help") return "agent-atlas scan|context --root DIR [--config RULES.json] [--domain NAME | --seed FILE]";
  if (!["scan", "context"].includes(a.command)) throw new Error(`Unknown command: ${a.command}`);
  const rules = a.config ? JSON.parse(readFileSync(safePath(a.root, a.config), "utf8")) : propose(inventory(a.root));
  const snapshot = build(a.root, rules);
  return a.command === "context" ? context(snapshot, a.scope) : json(snapshot);
}
if (import.meta.main) {
  main().then(output => console.log(output)).catch(e => { console.error(String(e.message ?? e)); process.exitCode = 1; });
}
