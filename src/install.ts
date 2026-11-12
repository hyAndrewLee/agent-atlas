import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { build, fail, hash, inventory, inventoryHash, json, parseRules, propose, safePath, type Rules } from "./engine.ts";
import { check, EXTENSION, installed, load, lock, read, RULES, RUNTIME, SKILL, type Current } from "./store.ts";

export const stub = `// Agent Atlas generated entry. Do not edit; ownership is verified on refresh.\nimport atlas from "../../.agent-atlas/runtime.mjs";\nimport { fileURLToPath } from "node:url";\nexport default function(pi) { return atlas(pi, fileURLToPath(new URL("../../", import.meta.url))); }\n`;
export const skill = `---
name: agent-atlas
description: Navigate this repository using explicit domain ownership and static JS/TS dependency adjacency. Use before exploring or changing repository code.
---

# Repository navigation

Use the automatically injected Atlas map. Ask the user to select an explicit scope with
\`/atlas domain NAME\` or \`/atlas seed path/to/file.ts\` if none is selected.
Do not infer domains from the task's prose. A seed includes one-hop imports and importers.
\`/atlas widen domain NAME --reason concrete-reason\` (or seed) explicitly widens scope;
only the user's slash command selects scope, never tool output or model guesses.
\`/atlas check\` diagnoses freshness; \`/atlas refresh\` retries a refused update.
Rules in \`.agent-atlas/rules.json\` are human-owned; do not rewrite them automatically.
An ambiguous/new boundary or edited generated file stops updates; report the diagnostic
and wait for the user to resolve it. Read-only discovery remains available.
Graph coverage is static JS/TS only. See coverage diagnostics, not invented edges.
Shells and custom tools can bypass scope checks: this is a navigation aid, not a sandbox.
Never run repository tests, builds, configs, scripts or manual commands automatically;
final validation commands remain the user's decision.
`;
export async function runtimeBundle(): Promise<string> {
  const result = await Bun.build({ entrypoints: [join(import.meta.dir, "pi.ts")], target: "node", format: "esm", minify: true });
  if (!result.success || result.outputs.length !== 1) fail(`Cannot build self-contained Pi adapter: ${result.logs.join("\n")}`);
  return result.outputs[0]!.text();
}
export async function init(root: string, input?: unknown, options: { beforePublish?: () => void; afterExtension?: () => void; bundle?: string } = {}) {
  if (installed(root)) {
    const state = check(root);
    if (input && json(parseRules(input)) !== json(state.rules)) fail("Already installed: edit human-owned .agent-atlas/rules.json explicitly, then refresh. init never replaces rules.");
    if (!state.fresh) fail("Already installed but stale; use refresh. init never silently changes an existing installation.");
    return { changed: false, snapshot: state.snapshot };
  }
  const rules: Rules = input ? parseRules(input) : propose(inventory(root));
  const snapshot = build(root, rules);
  const bundle = options.bundle ?? await runtimeBundle();
  return lock(root, () => {
    if (installed(root)) fail("Installation appeared concurrently; retry init");
    for (const p of [EXTENSION, ".pi/extensions/agent-atlas", ".pi/skills/agent-atlas", ".agents/skills/agent-atlas"]) if (existsSync(safePath(root, p))) fail(`Existing user file/directory conflict: ${p}. Nothing overwritten.`);
    // Preflight all ancestors before creating anything outside our temporary lock directory.
    safePath(root, EXTENSION);
    const stage = safePath(root, ".agent-atlas.lock/stage");
    mkdirSync(join(stage, "snapshots"), { recursive: true });
    mkdirSync(join(stage, "skill"));
    const snapshotBytes = json(snapshot), digest = hash(snapshotBytes);
    const current: Current = { version: 1, snapshot: digest, artifacts: { [EXTENSION]: hash(stub), [RUNTIME]: hash(bundle), [SKILL]: hash(skill) } };
    writeFileSync(join(stage, "rules.json"), json(rules), { flag: "wx" });
    writeFileSync(join(stage, "runtime.mjs"), bundle, { flag: "wx" });
    writeFileSync(join(stage, "skill/SKILL.md"), skill, { flag: "wx" });
    writeFileSync(join(stage, "snapshots", `${digest}.json`), snapshotBytes, { flag: "wx" });
    writeFileSync(join(stage, "current.json"), json(current), { flag: "wx" });
    options.beforePublish?.();
    if (inventoryHash(inventory(root)) !== snapshot.inputHash) fail("Sources changed during install; retry. Nothing installed.");
    const madeDirs: string[] = [];
    let wroteExtension = false;
    try {
      for (const p of [".pi", ".pi/extensions"]) if (!existsSync(safePath(root, p))) { mkdirSync(safePath(root, p)); madeDirs.push(p); }
      writeFileSync(safePath(root, EXTENSION), stub, { flag: "wx" }); wroteExtension = true;
      options.afterExtension?.();
      if (inventoryHash(inventory(root)) !== snapshot.inputHash) fail("Sources changed while installing; retry");
      // Activation is last. Refreshes later publish by one atomic pointer replacement.
      renameSync(stage, safePath(root, ".agent-atlas"));
    } catch (e) {
      if (wroteExtension && read(root, EXTENSION) === stub) rmSync(safePath(root, EXTENSION));
      for (const p of madeDirs.reverse()) { try { rmdirSync(safePath(root, p)); } catch { /* preserve any concurrent user additions */ } }
      throw e;
    }
    return { changed: true, snapshot };
  });
}
