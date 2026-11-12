import { relative, resolve } from "node:path";
import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { contains, context, fail, IGNORED, safePath, select, type Scope, type Snapshot } from "./engine.ts";
import { check, refresh } from "./store.ts";

export class AtlasSession {
  scope: Scope | undefined;
  snapshot: Snapshot | undefined;
  dirty = false;
  problem: string | undefined;
  constructor(public root: string) { this.root = realpathSync(root); }
  prepare(): string {
    try {
      const result = refresh(this.root);
      this.snapshot = result.snapshot;
      this.problem = undefined; this.dirty = false;
      if (this.scope) return context(result.snapshot, this.scope);
      const map = result.snapshot.domains.map(d => `${d.name}: ${d.paths.join(", ")}`).join("\n");
      return (`Agent Atlas: no task scope selected. Read-only discovery only; ask the user for /atlas domain NAME or /atlas seed FILE. Never guess from task text.\nDomain map:\n${map}\nStatic JS/TS only; ${result.snapshot.coverage.length} coverage limitations. Shell/custom tools are not a security sandbox.`).slice(0, 12000);
    } catch (e: any) {
      this.problem = String(e.message ?? e);
      return (`Agent Atlas cannot update navigation. Read-only diagnostics/discovery only; do not retry automatically in a loop. Ask the user to resolve rules/source/ownership, then /atlas refresh.\n${this.problem}`).slice(0, 12000);
    }
  }
  command(text: string): string {
    const [action, kind, value, ...rest] = text.trim().split(/\s+/);
    if (action === "check") {
      if (kind) fail("Usage: /atlas check");
      return check(this.root).fresh ? "Atlas is fresh." : "Atlas is stale. /atlas refresh updates only unambiguous structure.";
    }
    if (action === "refresh") {
      if (kind) fail("Usage: /atlas refresh");
      return this.prepare();
    }
    if (action === "clear") { this.scope = undefined; return "Atlas scope cleared; read-only discovery only."; }
    let next: Scope, reason = "";
    if (action === "widen") {
      if (!this.scope || !["domain", "seed"].includes(kind ?? "") || !value || rest[0] !== "--reason" || !rest.slice(1).join(" ").trim()) fail("Usage: /atlas widen domain NAME --reason REASON (or seed FILE), after selecting scope");
      reason = rest.slice(1).join(" ");
      next = { domains: [...(this.scope.domains ?? []), ...(kind === "domain" ? [value] : [])], seeds: [...(this.scope.seeds ?? []), ...(kind === "seed" ? [value] : [])] };
    } else {
      if (!["domain", "seed"].includes(action ?? "") || !kind || value) fail("Usage: /atlas domain NAME | seed FILE | widen domain NAME --reason REASON | check | refresh | clear");
      next = action === "domain" ? { domains: [kind] } : { seeds: [kind] };
    }
    const state = check(this.root);
    if (!state.fresh) fail("Atlas is stale; /atlas refresh before selecting scope");
    const nextFiles = select(state.snapshot, next);
    if (this.scope && action !== "widen") {
      const oldFiles = select(state.snapshot, this.scope);
      if ([...nextFiles].some(p => !oldFiles.has(p))) fail("Scope expansion needs /atlas widen domain NAME --reason REASON (or seed). Use /atlas clear to start a different task.");
    }
    this.scope = next; this.snapshot = state.snapshot; this.problem = undefined;
    return context(state.snapshot, next) + (reason ? `\nScope widened because: ${reason}` : "");
  }
  gate(toolName: string, input: Record<string, unknown>, cwd: string): string | undefined {
    const reads = ["read", "grep", "find", "ls"], writes = ["write", "edit"];
    const readonly = reads.includes(toolName), mutation = writes.includes(toolName);
    if (!this.scope || this.problem) {
      if (!readonly) return this.problem ? `Atlas requires user resolution: ${this.problem.slice(0, 1500)}` : "Select Atlas scope with /atlas domain NAME or /atlas seed FILE first. Read-only discovery remains available.";
    }
    if (!readonly && !mutation) return; // Explicit limitation: no shell/custom-tool sandbox.
    try {
      const raw = input.path ?? (readonly ? "." : undefined);
      if (typeof raw !== "string") fail("Tool needs a path");
      const spelling = raw.startsWith("@") ? raw.slice(1) : raw;
      if (spelling === "~" || spelling.startsWith("~/") || spelling.startsWith("file:") || /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(spelling)) fail("Use an exact repository path, not home/file-URL/Unicode-space aliases");
      const abs = resolve(cwd, spelling);
      if (!contains(this.root, abs)) fail("Tool path escapes Atlas repository");
      const p = relative(this.root, abs).split("\\").join("/") || ".";
      safePath(this.root, p);
      // Pi's native read has filename-spelling fallbacks. Require an existing
      // exact spelling so an unchecked fallback cannot resolve a different path.
      if (toolName === "read") { try { statSync(abs); } catch { fail("Read needs an exact existing path; filename-spelling fallbacks are not supported"); } }
      input.path = abs; // Align the checked path with what Pi actually executes.
      if (mutation && p.split("/").some(part => IGNORED.includes(part))) fail("Atlas/runtime/dependency metadata is protected; user must resolve it explicitly");
      if (readonly && contains(".agent-atlas", p)) return; // Diagnostics, rules, skill and immutable snapshots.
      if (!this.scope || this.problem) return;
      const s = this.snapshot!;
      const selected = select(s, this.scope);
      let directory = false;
      try { directory = statSync(abs).isDirectory(); } catch (e: any) { if (e.code !== "ENOENT") throw e; }
      if (toolName === "ls") return; // Names-only discovery, not file content.
      if (directory) {
        const descendants = s.files.filter(f => contains(p, f.path));
        if (!descendants.length || descendants.some(f => !selected.has(f.path))) fail("Search directory exceeds selected Atlas context; use a narrower path or explicitly widen scope");
        const checkTree = (dir: string) => {
          for (const name of readdirSync(dir)) {
            if (IGNORED.includes(name)) fail("Search directory contains reserved/unindexed areas; target a narrower directory or file");
            const child = resolve(dir, name), stat = lstatSync(child);
            if (stat.isSymbolicLink()) fail("Search directory contains a symlink; use exact safe file paths");
            if (stat.isDirectory()) checkTree(child);
          }
        };
        checkTree(abs);
      } else if (!selected.has(p)) {
        // New files are allowed only in explicitly selected domains, never guessed seed neighborhoods.
        const matches = s.domains.filter(d => d.paths.some(base => contains(base, p)));
        if (!mutation || matches.length !== 1 || !this.scope.domains?.includes(matches[0]!.name)) fail(`Path outside selected Atlas context: ${p}. Explicitly widen scope with a reason.`);
      }
    } catch (e: any) { return String(e.message ?? e); }
  }
  result(toolName: string, isError: boolean) {
    if (!isError && !["read", "grep", "find", "ls"].includes(toolName)) this.dirty = true;
  }
}
