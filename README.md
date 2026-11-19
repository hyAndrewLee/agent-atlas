# Agent Atlas

Explicit-domain repository navigation for coding agents. A Bun/TypeScript CLI builds a file map and static JS/TS dependency adjacency graph, installs a repository-navigation skill, and adds a **Pi-only** runtime extension. No model calls, embeddings, service, dashboard, or agent orchestration.

**v0.1 is conservative.** It does not guess what directories mean. Ambiguous ownership, unresolved local imports, unsafe paths, or edited generated artifacts refuse the entire update. Existing navigation stays active; Pi switches to read-only discovery until the user resolves the problem.

## Directory purpose summaries (opt-in local CLI)

This independent first slice produces `.agent-atlas/directory-summaries.json` (version 1); it does not alter the installed navigation graph, Pi hooks, or dependency coverage. Run `init` first if using both features: an existing unowned `.agent-atlas` area prevents `init`. No summaries run on install. In the target Git repository, invoke:

```sh
bun run /absolute/path/to/agent-atlas/src/cli.ts summaries-refresh --root /absolute/path/to/repo --target main --runner /absolute/path/to/trusted-local-model-runner --model AUTHOR_ID --review-model DIFFERENT_REVIEWER_ID
bun run /absolute/path/to/agent-atlas/src/cli.ts summaries-check --root /absolute/path/to/repo --target main --runner /absolute/path/to/trusted-local-model-runner --model AUTHOR_ID --review-model DIFFERENT_REVIEWER_ID
```

`--target` is an explicit local commit/ref (e.g. `main`), never inferred from a remote; `check` is read-only and exits nonzero when stale. Refresh compares that ref to the current index/working tree (including adds, modifications, deletions, both sides of renames). Output hashes the **working-tree bytes of Git-indexed regular files**, not HEAD, and includes a root `.` entry and each nonempty ancestor directory. Untracked files, symlinks, empty directories, `.git`, `.pi`, `.agent-atlas`, and `node_modules` are excluded. Missing indexed files count as deleted. No language-specific dependency edges are inferred. A changed directory and its ancestors are revisited bottom-up; summaries citing changed evidence are revisited too; unaffected descriptions are copied byte-for-byte. A no-op invokes no model. The canonical sorted JSON contains file hashes, descriptions and repository-relative evidence paths. Every directory must cite at least one extant file beneath it. Invalid evidence, rejected review, oversized jobs, changed inputs or runner failure leaves the previous output active; only one atomic rename publishes a complete replacement.

The runner is an **explicit caller-supplied trusted executable**, invoked without a shell as `RUNNER MODEL_ID`, once per job in fresh processes. It reads one JSON object on stdin (`role: "summarize"` or `"review"`, `instruction`, `context`, and for review `candidate`/`evidence`) and writes only one JSON object to stdout. Summarize returns `{ "description": "...", "evidence": ["path/to/file"] }`; review returns `{ "valid": true }` only when source supports both description and evidence. Wire this executable to your locally configured Pi/model backend or other model interface with **separate read-only model contexts** and distinct caller-selected model IDs. The CLI does not provide credentials, run repository scripts, grant model tools, or call a hosted service itself; the runner must disable code execution, file-writing tools and unsolicited tool access, and ensure its provider's privacy/credential policy is acceptable. Different IDs do **not** prove cross-family independence. Source text and model output are untrusted; paths, coverage and response shape are checked locally, but a dishonest reviewer or privileged runner is not a security boundary. Each indexed file is limited to 1 MiB, source excerpts to 12,000 characters, a job to 128,000 characters, and runner runtime to 120 seconds. Binary/large files should be excluded by the stated inventory rules or handled in a later slice; this first slice deliberately has no configuration for arbitrary exclude globs.

## Run from this checkout

Requires Bun **1.2.23+**. Pi must support the extension events described below (tested against the installed `@earendil-works/pi-coding-agent` host; check with the optional host test).

```sh
bun install --ignore-scripts
bun run src/cli.ts --help
bun run src/cli.ts init --root /absolute/path/to/repository
bun run src/cli.ts check --root /absolute/path/to/repository
bun run src/cli.ts context --root /absolute/path/to/repository --domain root
```

Auto-initialization is allowed only for a repository with **exactly one `package.json`, at its root**: that objective package boundary becomes domain `root` with path `.`. A repo without that boundary, or with nested packages, gets an actionable stdout proposal and **zero installation writes**. It needs explicit rules; Atlas never invents domains named after `src/services`, for example.

### Explicit rules for an ambiguous repository

Create this file yourself, inside the target repository, adapting it to cover **every** non-reserved file:

```json
{
  "version": 1,
  "domains": [
    { "name": "application", "paths": ["src"] },
    { "name": "tests", "paths": ["test"] },
    { "name": "metadata", "paths": ["package.json", "tsconfig.json"] }
  ],
  "exclude": ["README.md", "atlas-rules.json", "bun.lock"]
}
```

```sh
bun run /absolute/path/to/agent-atlas/src/cli.ts init \
  --root /absolute/path/to/repository --config atlas-rules.json
```

Paths are normalized, repository-relative **exact file or subtree prefixes**, not globs. `.` means the entire tree. Paths must be disjoint: a root `.` domain plus an exclusion below it is contradictory, not a precedence trick. Every inventoried file must match exactly one domain or exclusion. Domain names are case-sensitive simple identifiers. Config inputs are read from inside the target root; no arbitrary external paths.

The initial file is copied to **human-owned** `.agent-atlas/rules.json`. Edit that installed file explicitly to change rules, then run `refresh`. Atlas never edits it on refresh. `init` on an existing installation verifies unchanged generated artifacts and freshness, then does nothing; stale installations require `refresh`. It never replaces existing rules.

### Optional preapproved new packages

Add an explicit creation rule to your human-owned rules when that is really your policy:

```json
{
  "version": 1,
  "domains": [{ "name": "app", "paths": ["app"] }],
  "exclude": ["README.md", "atlas-rules.json"],
  "autoPackages": [{ "under": "packages", "prefix": "pkg-" }]
}
```

A direct child `packages/widget/package.json` objectively creates domain `pkg-widget` over `packages/widget`; no rules file is rewritten. The creation area cannot overlap explicit domains/exclusions or another creation area. Files there without a direct-child package manifest remain ambiguous. A conflicting domain name refuses the update.

New files inside existing domains update automatically. A **new non-excluded package boundary**, even inside an existing domain, requires an exact domain path for that package directory or a matching preapproved creation rule. Otherwise *all installed navigation, skill, extension and rules bytes remain unchanged*. Changes to existing package manifests do not infer new semantic domains.

## Commands

All commands accept `--root DIR` (default current directory). Options require separate values.

| Command | Behavior |
|---|---|
| `init [--config FILE]` | Validate everything, then install. Never overwrite an unowned file. |
| `check` | Read-only; exit 0 if fresh, 1 if stale/invalid/conflicting. |
| `refresh` | Publish only a fully validated, unambiguous new snapshot. |
| `scan [--config FILE]` | Read-only JSON inventory, domain map, adjacency and coverage report. Uses installed rules when available. |
| `context` / `query` | Read-only bounded text context. Require `--domain NAME` and/or `--seed FILE` (repeatable). Never refresh implicitly. |

A domain selects its inventoried files. A seed selects that JS/TS file plus its **one-hop imports and importers**; cycles are valid, not errors. Output is capped at 12,000 characters with an explicit truncation notice; narrower seeds give more detail. The complete graph remains available through `scan` and the current JSON snapshot. No test/build/manual command is inferred from source or documentation as verified.

Exit status is 1 for diagnostic failures; messages explain what needs an explicit decision. Read-only commands do not create locks or other files. Source freshness hashes **working-tree bytes**, not Git HEAD, mtimes or a commit identifier.

## Pi quickstart and automatic hooks

After `init`, start Pi **at the target repository root**, trust the project as usual, or run `/reload` in an existing root session. Atlas does not change global settings or grant project trust.

```text
/atlas domain application
/atlas seed src/index.ts
/atlas widen domain tests --reason verify callers and regression tests
/atlas widen seed src/shared.ts --reason inspect the imported contract
/atlas check
/atlas refresh
/atlas clear
```

Select one initial domain or seed. Once selected, expansion requires `/atlas widen ... --reason ...`; use `/atlas clear` for a different task. Scope is intentionally **session-local**, resets on reload/resume/new sessions, and is never guessed from a natural-language prompt. Slash commands do not call a provider. They return diagnostics/context even without a terminal UI.

The additive entry `.pi/extensions/agent-atlas.ts` loads a **self-contained Node-compatible ESM bundle** from `.agent-atlas/runtime.mjs`. The installer bundles its own engine and TypeScript parser with Bun; the target needs no `agent-atlas` or `typescript` import in `node_modules`. No target configs, scripts or dependencies are executed during indexing; bundling uses Atlas's own shipped compiler config. The runtime retains the bundled TypeScript dependency's legal notices without selecting a license for this project. The generated skill is `.agent-atlas/skill/SKILL.md`, discovered through Pi's `resources_discover` event. Existing instructions, settings and unrelated extensions/skills are untouched. Reserved extension/skill name collisions refuse installation.

Supported Pi events (not universal hooks):

- `session_start`: clear task scope and explain explicit selection.
- `resources_discover`: contribute the generated navigation skill.
- `before_agent_start`: automatically inject a bounded map, graph context or actionable diagnostic.
- `context`: recheck content freshness before each provider request, replace old Atlas messages with one current bounded context, and perform deferred refreshes.
- `tool_call`: check native `read`, `grep`, `find`, `ls`, `write`, `edit` paths where feasible; detect external edits since context was prepared. Blocked calls request termination, not a retry loop.
- `tool_result`: successful mutations mark the session dirty; failed edits do not.
- `agent_settled`: refresh dirty navigation once the run ends, without triggering another model turn.

Until scope is selected—or while indexing has a conflict—only native read-only discovery is permitted. After selection, file reads/edits must fit the selection; new files can be written under explicitly selected domains, not guessed seed neighborhoods. Recursive native searches must target a directory whose inventoried descendants are all selected and which contains no reserved/unindexed subtree (so root searches generally need a narrower path). `ls` remains names-only discovery. Native path checks require exact paths: home/file-URL/Unicode-space aliases and Pi's missing-file spelling fallbacks are rejected rather than checked differently from execution. Atlas metadata remains readable for diagnostics and protected against native edits; human rule changes are deliberate manual operations.

**Not a security sandbox.** Once scoped, arbitrary shell commands, custom tools, other extensions, remote tools and alternate search mechanisms are not comprehensively policed. Shell commands are not parsed or rewritten. Filesystem checks cannot prevent a malicious concurrent symlink/rename race. This is a navigation guardrail for cooperative local work, not process isolation. External edits are detected at request/tool boundaries, not continuously watched. Pi started below the root is unsupported and asks the user to restart at the root.

Final repository tests/builds/linters remain **user-controlled**; Atlas never automatically runs target commands.

## Installed data and atomic updates

```text
.agent-atlas/
  rules.json                   # human-owned, explicit domain policy
  runtime.mjs                  # generated, bundled engine + Pi adapter
  skill/SKILL.md               # generated repository-navigation skill
  snapshots/<sha256>.json      # immutable map + inventory + adjacency + coverage
  current.json                 # atomic activation/ownership pointer
.pi/extensions/agent-atlas.ts   # additive generated entry
```

A snapshot includes sorted domain/path ownership for every inventoried file, all JS/TS nodes (including isolated files), sorted outgoing adjacency, unverified nonlocal imports, coverage diagnostics, source content hashes and rules hash. No timestamps or absolute source paths are embedded. Identical inputs produce identical content. Old snapshots are retained, not silently deleted.

Writers serialize through a repository-local exclusive `.agent-atlas.lock` directory. Installation stages everything there, checks source freshness again, creates the additive entry exclusively, and activates the complete Atlas directory last. Ordinary errors roll back only bytes/directories created by that attempt, preserving concurrent user additions. Updates write an immutable snapshot and atomically replace **one** pointer; stale sources/rules, generated-content edits, and conflicting ownership never activate partial navigation.

A process kill, machine failure, or power loss during the first multi-path install can leave the lock and/or an inactive entry. There is no cross-directory filesystem transaction or crash-recovery daemon: inspect the remaining files and restore/remove only the incomplete Atlas-owned attempt **after confirming no writer is running**, then retry. Do not blindly delete another writer's lock. Atomic rename provides process-level visibility, not an fsync/power-loss durability guarantee. An uncooperative source writer can still change files after the last optimistic hash check; the next boundary detects that change.

Generated files are hash-verified; editing them causes a conflict instead of an overwrite. Restoring their original bytes is the simplest repair. There is no automatic migration/uninstall command in v1. Remove only Atlas-created paths manually if you want to uninstall; keep human changes and existing `.pi` directories intact.

## Exact indexing boundaries

- Parser: TypeScript **5.9.3** AST, not import regexes. Source suffixes: `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` (including declaration TS files).
- Edges: static `import`, side-effect imports, `export ... from`, `export * from`, type-only imports/exports, TS `import x = require("...")`, and literal TS import types `import("...").T`. Deduplicated; cycles supported.
- Resolution: TypeScript Bundler resolution over an **in-memory repository-only filesystem**. Relative paths, extension substitution (`./x.js` to `x.ts`), directory index resolution, and nearest self-contained `tsconfig.json`/`jsconfig.json` `compilerOptions.baseUrl`/`paths` aliases are supported. Configs are parsed as JSON/JSONC, never imported/executed.
- In applicable nearest configs, `extends`, project `references`, `rootDirs`, `moduleSuffixes` and `customConditions` are rejected, not silently approximated. Flatten or adapt configs explicitly yourself if appropriate; Atlas does not rewrite them. Bundler mode is fixed, not NodeNext's exact runtime behavior.
- Workspace/package-name imports without a resolvable local alias, package `#imports`, unresolved relative imports, asset/CSS/JSON imports, and local targets that are excluded or unsupported are blocking local-resolution errors. Configure supported local aliases explicitly; v1 does not implement workspace export-map linking or bundler plugins.
- Unresolved bare specifiers not known to be local are recorded separately as **nonlocal, unverified modules**, including `node:`/`bun:` builtins. No package installation or version/export verification occurs. A missing unconfigured bare alias cannot reliably be distinguished from an external package; declare aliases explicitly.
- Dynamic `import(...)` (even string literals), ordinary `require(...)` calls (including potentially shadowed identifiers), `import.meta` usage and triple-slash references are reported as unindexed coverage limitations, **not invented edges**. `eval`/reflection, generated loaders and framework plugin semantics are outside static analysis.
- All other non-excluded files are inventory-only and explicitly reported as such; unsupported languages/framework source files are not dependency parsed. JS/TS syntax parse errors stop the update. This is not a typechecker or verifier of runtime behavior.
- Built-in reserved directory/file names `.git`, `node_modules`, `.pi`, `.agent-atlas`, `.agent-atlas.lock` are skipped at every depth. User `.pi` code is deliberately outside the graph. `.gitignore` is **not** interpreted; other build/vendor output must be mapped or explicitly excluded. Excluded files are still inventoried/hashed so structural additions are not missed.
- Indexed paths and explicit installation/runtime paths reject symlinks, traversal, backslashes, control characters and non-normalized paths. Symlinks inside reserved skipped directories are not traversed. Special filesystem entries and files over **8 MiB** refuse scanning, even when explicitly excluded. Case sensitivity follows the local filesystem; cross-platform path-case equivalence is not promised.

## Local package / bunx smoke-tested invocation

**No npm release is assumed. `bunx agent-atlas` is not promised to work.** From this checkout, produce a local archive, then use a separate launcher directory so the target's package/config files need not change:

```sh
# In this checkout:
bun pm pack --ignore-scripts --filename /absolute/path/agent-atlas.tgz
# In a separate launcher directory with its own package.json:
bun add --dev --ignore-scripts /absolute/path/agent-atlas.tgz
bunx --no-install agent-atlas init --root /absolute/path/to/target
bunx --no-install agent-atlas check --root /absolute/path/to/target
```

The archive includes the CLI/runtime source and declares TypeScript as a runtime dependency. Bun compiles the self-contained runtime at explicit `init` time; there are no lifecycle install scripts. The local tarball → Bun dependency installation → `bunx --no-install` → real target initialization path is exercised by the package smoke test. Publication and license selection remain owner decisions.

## Tests

```sh
bun test
bun run typecheck
# Optional actual Pi jiti-loader integration, no provider/model required:
ATLAS_PI_DIR=/absolute/path/to/node_modules/@earendil-works/pi-coding-agent bun test
```

Tests use temporary fixture repositories, CLI/Node subprocesses, fault-injected installation/update boundaries, real AST resolution, byte-identical refusal assertions, a mocked documented Pi event surface, and a real packed-package installation. The package test may download TypeScript into its temporary cache; it never publishes or invokes target scripts. The optional test loads the generated entry through Pi's actual installed extension loader. No CI workflow is included.

No speedup, latency, or large-repository scaling benchmark is claimed. Freshness currently hashes the full inventory at boundaries; unchanged trees avoid AST re-parsing, but this is not an incremental filesystem index. Bundle size, retained snapshots and repeated hashing are deliberate v1 costs to measure before optimizing.
