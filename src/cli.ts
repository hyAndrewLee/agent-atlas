#!/usr/bin/env bun
import { readFileSync, realpathSync } from "node:fs";
import { AtlasError, build, context, inventory, json, propose, safePath } from "./engine.ts";
import { init } from "./install.ts";
import { check, installed, load, refresh } from "./store.ts";
import { summaries } from "./summaries.ts";

export function args(argv: string[]) {
  const [command = "help", ...rest] = argv;
  let root = process.cwd(),
    config: string | undefined;
  const domains: string[] = [],
    seeds: string[] = [];
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i],
      value = rest[i + 1];
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
  if (["summaries-refresh", "summaries-check"].includes(argv[0] ?? "")) {
    const [command, ...rest] = argv;
    const options: Record<string, string> = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (
        !["--root", "--target", "--runner", "--model", "--review-model"].includes(rest[i]!) ||
        !rest[i + 1] ||
        options[rest[i]!]
      )
        throw new Error(`Invalid summary option: ${rest[i]}`);
      options[rest[i]!] = rest[i + 1]!;
    }
    if (
      !options["--target"] ||
      !options["--runner"] ||
      !options["--model"] ||
      !options["--review-model"]
    )
      throw new Error(
        "Require --target REF --runner ABSOLUTE_PATH --model ID --review-model DIFFERENT_ID",
      );
    const result = summaries(
      options["--root"] ?? process.cwd(),
      options["--target"],
      options["--runner"],
      options["--model"],
      options["--review-model"],
      command === "summaries-refresh",
    );
    if ("fresh" in result && !result.fresh)
      throw new Error(
        `Directory summaries stale: ${(result.affected ?? []).join(", ")}; run summaries-refresh`,
      );
    return JSON.stringify(result);
  }
  const a = args(argv);
  if (a.command === "help" || a.command === "--help")
    return "agent-atlas init|check|refresh|scan|context|query|summaries-refresh|summaries-check [--root DIR] [--config RULES.json] [--domain NAME | --seed FILE]\ninit: optional explicit --config; check/context/query/scan are read-only; refresh never changes human rules.";
  if (!["init", "check", "refresh", "scan", "context", "query"].includes(a.command))
    throw new Error(`Unknown command: ${a.command}`);
  if (a.config && !["init", "scan"].includes(a.command))
    throw new Error(
      "--config is only accepted by init/scan; installed rules are .agent-atlas/rules.json",
    );
  const input = a.config ? JSON.parse(readFileSync(safePath(a.root, a.config), "utf8")) : undefined;
  if (a.command === "init") {
    const r = await init(a.root, input);
    return `${r.changed ? "Installed" : "Already installed (unchanged)"}. ${r.snapshot.nodes.length} graph nodes. Start Pi at this root or /reload.\nCoverage:\n${r.snapshot.coverage.join("\n") || "No known unsupported constructs found; static JS/TS only."}`;
  }
  if (a.command === "refresh") {
    const r = refresh(a.root);
    return `${r.changed ? "Refreshed" : "Already fresh"}. ${r.snapshot.nodes.length} nodes.\n${r.snapshot.coverage.join("\n")}`;
  }
  if (a.command === "check") {
    const r = check(a.root);
    if (!r.fresh) throw new Error("Atlas is stale; run refresh. No files written.");
    return `Fresh: ${r.snapshot.inputHash}\n${r.snapshot.coverage.join("\n")}`;
  }
  if (a.command === "scan") {
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
