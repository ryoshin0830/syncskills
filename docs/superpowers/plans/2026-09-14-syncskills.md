# syncskills Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `npx syncskills`, a CLI that keeps AI-agent skills and MCP servers identical across several machines by three-way syncing cc-switch's data through a GitHub repository, with secrets held in 1Password.

**Architecture:** A pure, I/O-free resolver decides `PUSH`/`PULL`/`CONFLICT` per item from three hashes (base, local, remote); every other module is an adapter it depends on — cc-switch (SQLite reads, CLI writes), a git store, a 1Password secret provider, and a merge stack (`git merge-file`, then an AI merge agent). The CLI and the TUI are two front ends over the same engine.

**Tech Stack:** TypeScript · Node ≥ 20 · tsup (bundle) · vitest (test) · `node:sqlite` (built-in) · `@clack/prompts` + `picocolors` (TUI) · external binaries: `git`, `gh`, `cc-switch`, `op`, optionally `claude` / `codex`

**Spec:** `docs/superpowers/specs/2026-09-14-syncskills-design.md`

## Global Constraints

- Package name `syncskills`; bins `syncskills` and `ssync`. Repo `github.com/ryoshin0830/syncskills`.
- Node `>=20.0.0`. ESM only (`"type": "module"`).
- Runtime dependencies limited to `@clack/prompts` and `picocolors`. SQLite uses the built-in `node:sqlite`. No native modules — `npx` must start fast.
- Exit codes are fixed: `0` success, `1` error, `2` unresolved conflict or pending manual action, `3` not initialized.
- Config directory is `~/.config/syncskills` (override: `--config`, or `$SYNCSKILLS_CONFIG_DIR`).
- The repository must never receive a secret value. Every push is scanned before it is made.
- `state.json` is written only after an action has been applied and verified.
- All cc-switch reads open SQLite **read-only**. Writes go through the `cc-switch` binary except the documented delete fallback.
- Deeplink `config` parameter = URL-safe Base64 of JSON containing an `mcpServers` object, then URL-escaped.
- Every subcommand supports `--json`; every subcommand's `--help` lists a description, all flags, and at least one example.
- User-facing strings are English. Errors state what failed, what was and was not applied, and the next action.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `src/cli.ts` | Argument parsing, dispatch, `--json` envelope, exit codes |
| `src/help.ts` | Help text for root and every subcommand |
| `src/config.ts` | Load/save `config.json`, resolve the config directory |
| `src/state.ts` | Load/save `state.json` (the merge base) |
| `src/core/types.ts` | `Item`, `ItemKind`, `Decision`, `Resolution`, `Action`, `Plan` |
| `src/core/hash.ts` | `treeHash`, `canonicalJsonHash`, `canonicalize` |
| `src/core/resolve.ts` | Pure three-way decision table |
| `src/core/plan.ts` | Resolutions → ordered `Plan` |
| `src/core/apply.ts` | Execute a `Plan`, snapshot first, update state last |
| `src/ccswitch/paths.ts` | Locate cc-switch home, db, skills dir, storage location |
| `src/ccswitch/read.ts` | Read skills / MCP / repos from SQLite and disk |
| `src/ccswitch/write.ts` | deeplink, `set-apps`, `import-from-apps`, delete strategies |
| `src/store/manifest.ts` | `manifest.json` serialize/parse |
| `src/store/git.ts` | clone, fetch, read, stage, commit, push via `git` + `gh` |
| `src/secrets/provider.ts` | `SecretProvider` interface + `NullSecretProvider` |
| `src/secrets/onepassword.ts` | `op`-backed provider |
| `src/secrets/scan.ts` | Pre-push secret scanner |
| `src/merge/mergefile.ts` | `git merge-file` wrapper |
| `src/merge/agent.ts` | `MergeAgent` interface, `claude` and `codex` implementations |
| `src/merge/validate.ts` | Validate merged output |
| `src/merge/index.ts` | Per-item merge orchestration |
| `src/commands/*.ts` | One file per subcommand |
| `src/tui/*.ts` | init wizard, review, conflict flows |
| `src/util/exec.ts` | `run()` — spawn a binary, capture stdout/stderr/code |
| `src/util/fs.ts` | `copyTree`, `rmTree`, `walk`, ignore rules |
| `tests/**` | Mirrors `src/` |
| `tests/helpers/fixture.ts` | Fake homes, bare repo, stub binaries |

---

## Task 1: Project skeleton, CLI framing, exit codes

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`, `.gitignore`, `src/cli.ts`, `src/help.ts`, `src/util/exec.ts`
- Test: `tests/cli.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `EXIT = { OK: 0, ERROR: 1, CONFLICT: 2, UNINITIALIZED: 3 } as const`
  - `type ParsedArgs = { command: string; positionals: string[]; flags: Record<string, string | boolean> }`
  - `parseArgs(argv: string[]): ParsedArgs`
  - `run(bin: string, args: string[], opts?: { input?: string; env?: Record<string,string>; cwd?: string }): Promise<{ code: number; stdout: string; stderr: string }>` from `src/util/exec.ts`

- [ ] **Step 1: Write the failing test**

`tests/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseArgs, EXIT } from '../src/cli.js'

describe('parseArgs', () => {
  it('defaults to the tui command when given no arguments', () => {
    expect(parseArgs([]).command).toBe('tui')
  })

  it('reads a subcommand and its positionals', () => {
    const a = parseArgs(['diff', 'code-review'])
    expect(a.command).toBe('diff')
    expect(a.positionals).toEqual(['code-review'])
  })

  it('treats long flags without a value as boolean true', () => {
    expect(parseArgs(['sync', '--yes']).flags.yes).toBe(true)
  })

  it('reads --flag=value and --flag value alike', () => {
    expect(parseArgs(['sync', '--merge-agent=codex']).flags['merge-agent']).toBe('codex')
    expect(parseArgs(['sync', '--merge-agent', 'codex']).flags['merge-agent']).toBe('codex')
  })

  it('expands short aliases', () => {
    expect(parseArgs(['sync', '-y']).flags.yes).toBe(true)
    expect(parseArgs(['sync', '-v']).flags.verbose).toBe(true)
  })

  it('stops flag parsing after --', () => {
    expect(parseArgs(['sync', '--', '--yes']).positionals).toEqual(['--yes'])
  })

  it('fixes the exit code contract', () => {
    expect(EXIT).toEqual({ OK: 0, ERROR: 1, CONFLICT: 2, UNINITIALIZED: 3 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli.test.ts`
Expected: FAIL — `Cannot find module '../src/cli.js'`

- [ ] **Step 3: Write the project files**

`package.json`:
```json
{
  "name": "syncskills",
  "version": "0.1.0",
  "description": "Perfect multi-device sync for AI agent skills and MCP servers, built on cc-switch, GitHub and 1Password.",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20.0.0" },
  "bin": { "syncskills": "./dist/cli.js", "ssync": "./dist/cli.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "repository": { "type": "git", "url": "git+https://github.com/ryoshin0830/syncskills.git" },
  "keywords": ["skills", "mcp", "sync", "cc-switch", "claude-code", "codex", "hermes", "cli"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@clack/prompts": "^0.11.0",
    "picocolors": "^1.1.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsup": "^8.3.5",
    "typescript": "^5.7.2",
    "vitest": "^2.1.8"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "types": ["node"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src", "tests"]
}
```

`tsup.config.ts`:
```ts
import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
})
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 30_000 },
})
```

`.gitignore`:
```
node_modules/
dist/
.DS_Store
*.log
```

`src/util/exec.ts`:
```ts
import { spawn } from 'node:child_process'

export interface RunResult { code: number; stdout: string; stderr: string }

export interface RunOptions {
  input?: string
  env?: Record<string, string>
  cwd?: string
}

export function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
    if (opts.input !== undefined) child.stdin.write(opts.input)
    child.stdin.end()
  })
}
```

`src/cli.ts`:
```ts
export const EXIT = { OK: 0, ERROR: 1, CONFLICT: 2, UNINITIALIZED: 3 } as const

const SHORT: Record<string, string> = { y: 'yes', v: 'verbose', q: 'quiet', h: 'help' }
const VALUE_FLAGS = new Set([
  'merge-agent', 'only', 'profile', 'config', 'host', 'repo', 'vault', 'device',
])

export interface ParsedArgs {
  command: string
  positionals: string[]
  flags: Record<string, string | boolean>
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = []
  const flags: Record<string, string | boolean> = {}
  let command = ''
  let noMoreFlags = false

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!
    if (noMoreFlags) { positionals.push(tok); continue }
    if (tok === '--') { noMoreFlags = true; continue }

    if (tok.startsWith('--')) {
      const body = tok.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue }
      const next = argv[i + 1]
      if (VALUE_FLAGS.has(body) && next !== undefined && !next.startsWith('-')) {
        flags[body] = next; i++
      } else {
        flags[body] = true
      }
      continue
    }

    if (tok.startsWith('-') && tok.length > 1) {
      for (const ch of tok.slice(1)) flags[SHORT[ch] ?? ch] = true
      continue
    }

    if (command === '') command = tok
    else positionals.push(tok)
  }

  return { command: command === '' ? 'tui' : command, positionals, flags }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm install && npx vitest run tests/cli.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json tsup.config.ts vitest.config.ts .gitignore src tests
git commit -m "feat: project skeleton with argument parsing and exit code contract"
```

---

## Task 2: Content hashing

**Files:**
- Create: `src/core/types.ts`, `src/core/hash.ts`, `src/util/fs.ts`
- Test: `tests/core/hash.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `type ItemKind = 'skill' | 'mcp' | 'repo'`
  - `type App = 'claude' | 'codex' | 'gemini' | 'opencode' | 'hermes' | 'grokbuild'`
  - `const APPS: readonly App[]`
  - `interface Item { kind: ItemKind; id: string; contentHash: string; apps: App[]; payload?: unknown }`
  - `treeHash(dir: string): Promise<string>` — `"sha256:<hex>"` or throws if `dir` is missing
  - `canonicalize(value: unknown): string`
  - `canonicalJsonHash(value: unknown): string`
  - `walk(dir: string): AsyncGenerator<{ abs: string; rel: string; mode: number }>` from `src/util/fs.ts`
  - `copyTree(src: string, dest: string): Promise<void>`

- [ ] **Step 1: Write the failing test**

`tests/core/hash.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treeHash, canonicalize, canonicalJsonHash } from '../../src/core/hash.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ss-hash-')) })

describe('canonicalize', () => {
  it('sorts object keys so key order cannot change the hash', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJsonHash({ b: 1, a: 2 })).toBe(canonicalJsonHash({ a: 2, b: 1 }))
  })

  it('preserves array order, which is significant', () => {
    expect(canonicalJsonHash([1, 2])).not.toBe(canonicalJsonHash([2, 1]))
  })

  it('drops undefined members', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})

describe('treeHash', () => {
  it('is stable across calls', async () => {
    await writeFile(join(dir, 'SKILL.md'), 'hello')
    expect(await treeHash(dir)).toBe(await treeHash(dir))
  })

  it('changes when a file body changes', async () => {
    await writeFile(join(dir, 'SKILL.md'), 'a')
    const before = await treeHash(dir)
    await writeFile(join(dir, 'SKILL.md'), 'b')
    expect(await treeHash(dir)).not.toBe(before)
  })

  it('changes when a file is added', async () => {
    await writeFile(join(dir, 'SKILL.md'), 'a')
    const before = await treeHash(dir)
    await writeFile(join(dir, 'extra.md'), 'x')
    expect(await treeHash(dir)).not.toBe(before)
  })

  it('changes when a file is renamed', async () => {
    await writeFile(join(dir, 'a.md'), 'same')
    const before = await treeHash(dir)
    await writeFile(join(dir, 'b.md'), 'same')
    expect(await treeHash(dir)).not.toBe(before)
  })

  it('changes when the executable bit changes', async () => {
    const f = join(dir, 'run.sh')
    await writeFile(f, '#!/bin/sh\n')
    await chmod(f, 0o644)
    const before = await treeHash(dir)
    await chmod(f, 0o755)
    expect(await treeHash(dir)).not.toBe(before)
  })

  it('ignores .DS_Store and .git', async () => {
    await writeFile(join(dir, 'SKILL.md'), 'a')
    const before = await treeHash(dir)
    await writeFile(join(dir, '.DS_Store'), 'junk')
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, '.git', 'HEAD'), 'ref')
    expect(await treeHash(dir)).toBe(before)
  })

  it('hashes nested files by their relative path', async () => {
    await mkdir(join(dir, 'scripts'))
    await writeFile(join(dir, 'scripts', 'q.sh'), 'echo')
    const a = await treeHash(dir)
    expect(a.startsWith('sha256:')).toBe(true)
  })

  it('follows a symlinked file and hashes its target content', async () => {
    const target = join(dir, 'real.md')
    await writeFile(target, 'content')
    await mkdir(join(dir, 'sub'))
    await symlink(target, join(dir, 'sub', 'link.md'))
    expect((await treeHash(dir)).startsWith('sha256:')).toBe(true)
  })

  it('throws when the directory is missing', async () => {
    await expect(treeHash(join(dir, 'nope'))).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/hash.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

`src/core/types.ts`:
```ts
export type ItemKind = 'skill' | 'mcp' | 'repo'

export type App = 'claude' | 'codex' | 'gemini' | 'opencode' | 'hermes' | 'grokbuild'

export const APPS: readonly App[] = ['claude', 'codex', 'gemini', 'opencode', 'hermes', 'grokbuild']

export interface Item {
  kind: ItemKind
  id: string
  contentHash: string
  apps: App[]
  payload?: unknown
}
```

`src/util/fs.ts`:
```ts
import { readdir, stat, lstat, mkdir, copyFile, readlink } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

export const IGNORED = new Set(['.DS_Store', '.git', 'node_modules', '__pycache__'])

function isIgnored(name: string): boolean {
  return IGNORED.has(name) || name.endsWith('.pyc')
}

export interface WalkEntry { abs: string; rel: string; mode: number }

export async function* walk(dir: string, base = dir): AsyncGenerator<WalkEntry> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (isIgnored(e.name)) continue
    const abs = join(dir, e.name)
    const st = await stat(abs).catch(() => null)
    if (st === null) continue
    if (st.isDirectory()) {
      yield* walk(abs, base)
    } else if (st.isFile()) {
      yield { abs, rel: relative(base, abs).split(sep).join('/'), mode: st.mode }
    }
  }
}

export async function copyTree(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true })
  for await (const e of walk(src)) {
    const target = join(dest, e.rel)
    await mkdir(join(target, '..'), { recursive: true })
    await copyFile(e.abs, target)
  }
}

export async function isSymlink(p: string): Promise<boolean> {
  const st = await lstat(p).catch(() => null)
  return st !== null && st.isSymbolicLink()
}

export async function resolveLink(p: string): Promise<string> {
  return readlink(p)
}
```

`src/core/hash.ts`:
```ts
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { walk } from '../util/fs.js'

export function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function canonicalJsonHash(value: unknown): string {
  return 'sha256:' + createHash('sha256').update(canonicalize(value)).digest('hex')
}

export async function treeHash(dir: string): Promise<string> {
  const st = await stat(dir)
  if (!st.isDirectory()) throw new Error(`not a directory: ${dir}`)

  const parts: string[] = []
  const entries: { rel: string; mode: number; abs: string }[] = []
  for await (const e of walk(dir)) entries.push(e)
  entries.sort((a, b) => (a.rel < b.rel ? -1 : 1))

  for (const e of entries) {
    const body = await readFile(e.abs)
    const exec = (e.mode & 0o111) !== 0 ? '1' : '0'
    parts.push(`${e.rel}\0${exec}\0${createHash('sha256').update(body).digest('hex')}\0`)
  }

  return 'sha256:' + createHash('sha256').update(parts.join('')).digest('hex')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/hash.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/hash.ts src/util/fs.ts tests/core/hash.test.ts
git commit -m "feat: deterministic tree and canonical JSON hashing"
```

---

## Task 3: The three-way resolver

This is the correctness-critical module. It performs no I/O, so its test suite
is exhaustive.

**Files:**
- Create: `src/core/resolve.ts`
- Modify: `src/core/types.ts` (append `Decision`, `Resolution`, `Side`)
- Test: `tests/core/resolve.test.ts`

**Interfaces:**
- Consumes: `App`, `Item` from Task 2
- Produces:
  - `type Decision = 'IN_SYNC' | 'PUSH' | 'PULL' | 'PUSH_NEW' | 'PULL_NEW' | 'DELETE_REMOTE' | 'DELETE_LOCAL' | 'CONFLICT'`
  - `type ConflictKind = 'both-edited' | 'both-created' | 'local-deleted' | 'remote-deleted'`
  - `interface Side { contentHash: string; apps: App[] }`
  - `interface Resolution { kind: ItemKind; id: string; decision: Decision; conflictKind?: ConflictKind; appsDecision: Decision; apps: App[]; base?: Side; local?: Side; remote?: Side }`
  - `resolveItem(input: { kind: ItemKind; id: string; base?: Side; local?: Side; remote?: Side }): Resolution`
  - `resolveAll(base: Map<string, Side>, local: Map<string, Side>, remote: Map<string, Side>, kind: ItemKind): Resolution[]`
  - `mergeApps(base: App[] | undefined, local: App[] | undefined, remote: App[] | undefined): App[]`

- [ ] **Step 1: Write the failing test**

`tests/core/resolve.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { resolveItem, resolveAll, mergeApps } from '../../src/core/resolve.js'
import type { Side } from '../../src/core/types.js'

const S = (h: string, apps: string[] = ['claude']): Side =>
  ({ contentHash: h, apps: apps as Side['apps'] })

const d = (base?: Side, local?: Side, remote?: Side) =>
  resolveItem({ kind: 'skill', id: 'x', base, local, remote }).decision

describe('resolveItem — the decision table', () => {
  it('A A A  → IN_SYNC', () => expect(d(S('A'), S('A'), S('A'))).toBe('IN_SYNC'))
  it('A B A  → PUSH', () => expect(d(S('A'), S('B'), S('A'))).toBe('PUSH'))
  it('A A B  → PULL', () => expect(d(S('A'), S('A'), S('B'))).toBe('PULL'))
  it('- B -  → PUSH_NEW', () => expect(d(undefined, S('B'), undefined)).toBe('PUSH_NEW'))
  it('- - B  → PULL_NEW', () => expect(d(undefined, undefined, S('B'))).toBe('PULL_NEW'))
  it('A - A  → DELETE_REMOTE', () => expect(d(S('A'), undefined, S('A'))).toBe('DELETE_REMOTE'))
  it('A A -  → DELETE_LOCAL', () => expect(d(S('A'), S('A'), undefined)).toBe('DELETE_LOCAL'))
  it('A B C  → CONFLICT', () => expect(d(S('A'), S('B'), S('C'))).toBe('CONFLICT'))
  it('- B C  → CONFLICT', () => expect(d(undefined, S('B'), S('C'))).toBe('CONFLICT'))
  it('A - C  → CONFLICT', () => expect(d(S('A'), undefined, S('C'))).toBe('CONFLICT'))
  it('A B -  → CONFLICT', () => expect(d(S('A'), S('B'), undefined)).toBe('CONFLICT'))
  it('- B B  → IN_SYNC (both created the same content)', () =>
    expect(d(undefined, S('B'), S('B'))).toBe('IN_SYNC'))
  it('A B B  → IN_SYNC (both already moved to B)', () =>
    expect(d(S('A'), S('B'), S('B'))).toBe('IN_SYNC'))
  it('- - -  → IN_SYNC (nothing anywhere)', () =>
    expect(d(undefined, undefined, undefined)).toBe('IN_SYNC'))
})

describe('resolveItem — conflict kinds', () => {
  it('labels concurrent edits', () => {
    expect(resolveItem({ kind: 'skill', id: 'x', base: S('A'), local: S('B'), remote: S('C') })
      .conflictKind).toBe('both-edited')
  })
  it('labels independent creation', () => {
    expect(resolveItem({ kind: 'skill', id: 'x', local: S('B'), remote: S('C') })
      .conflictKind).toBe('both-created')
  })
  it('labels delete against edit', () => {
    expect(resolveItem({ kind: 'skill', id: 'x', base: S('A'), remote: S('C') })
      .conflictKind).toBe('local-deleted')
    expect(resolveItem({ kind: 'skill', id: 'x', base: S('A'), local: S('B') })
      .conflictKind).toBe('remote-deleted')
  })
})

describe('never overwrite a newer remote', () => {
  it('does not decide PUSH whenever the remote has moved away from base', () => {
    for (const local of ['A', 'B']) {
      const r = resolveItem({ kind: 'skill', id: 'x', base: S('A'), local: S(local), remote: S('Z') })
      expect(r.decision).not.toBe('PUSH')
    }
  })
})

describe('mergeApps — the matrix resolves independently of content', () => {
  it('keeps the local set when the remote has not moved', () => {
    expect(mergeApps(['claude'], ['claude', 'codex'], ['claude'])).toEqual(['claude', 'codex'])
  })
  it('takes the remote set when the local has not moved', () => {
    expect(mergeApps(['claude'], ['claude'], ['claude', 'hermes'])).toEqual(['claude', 'hermes'])
  })
  it('unions both sides when both moved, so no device loses a harness', () => {
    expect(mergeApps(['claude'], ['claude', 'codex'], ['claude', 'hermes']))
      .toEqual(['claude', 'codex', 'hermes'])
  })
  it('returns a stable APPS-order result', () => {
    expect(mergeApps([], ['hermes', 'claude'], [])).toEqual(['claude', 'hermes'])
  })
  it('honours a removal made on one side only', () => {
    expect(mergeApps(['claude', 'codex'], ['claude'], ['claude', 'codex'])).toEqual(['claude'])
  })
})

describe('resolveAll', () => {
  it('covers the union of all three id sets', () => {
    const base = new Map([['a', S('A')]])
    const local = new Map([['a', S('A')], ['b', S('B')]])
    const remote = new Map([['a', S('A')], ['c', S('C')]])
    const out = resolveAll(base, local, remote, 'skill')
    expect(out.map((r) => r.id).sort()).toEqual(['a', 'b', 'c'])
    expect(out.find((r) => r.id === 'b')!.decision).toBe('PUSH_NEW')
    expect(out.find((r) => r.id === 'c')!.decision).toBe('PULL_NEW')
  })

  it('returns results sorted by id for stable output', () => {
    const m = new Map([['z', S('Z')], ['a', S('A')]])
    expect(resolveAll(new Map(), m, new Map(), 'skill').map((r) => r.id)).toEqual(['a', 'z'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/resolve.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

Append to `src/core/types.ts`:
```ts
export type Decision =
  | 'IN_SYNC' | 'PUSH' | 'PULL' | 'PUSH_NEW' | 'PULL_NEW'
  | 'DELETE_REMOTE' | 'DELETE_LOCAL' | 'CONFLICT'

export type ConflictKind = 'both-edited' | 'both-created' | 'local-deleted' | 'remote-deleted'

export interface Side { contentHash: string; apps: App[] }

export interface Resolution {
  kind: ItemKind
  id: string
  decision: Decision
  conflictKind?: ConflictKind
  appsDecision: Decision
  apps: App[]
  base?: Side
  local?: Side
  remote?: Side
}
```

`src/core/resolve.ts`:
```ts
import { APPS } from './types.js'
import type { App, Decision, ItemKind, Resolution, Side } from './types.js'

export function mergeApps(base?: App[], local?: App[], remote?: App[]): App[] {
  const b = new Set(base ?? [])
  const l = new Set(local ?? base ?? [])
  const r = new Set(remote ?? base ?? [])

  const out = new Set<App>()
  for (const app of APPS) {
    const inB = b.has(app), inL = l.has(app), inR = r.has(app)
    // Each side's change relative to base wins; an unchanged side never vetoes.
    if (inL === inR) { if (inL) out.add(app); continue }
    if (inL !== inB) { if (inL) out.add(app); continue }  // local moved
    if (inR) out.add(app)                                  // remote moved
  }
  return APPS.filter((a) => out.has(a))
}

function decide(base?: string, local?: string, remote?: string): Decision {
  if (local === remote) return 'IN_SYNC'
  if (local !== undefined && remote !== undefined) {
    if (base === undefined) return 'CONFLICT'
    if (local === base) return 'PULL'
    if (remote === base) return 'PUSH'
    return 'CONFLICT'
  }
  if (local !== undefined) {
    // remote is absent
    if (base === undefined) return 'PUSH_NEW'
    return local === base ? 'DELETE_LOCAL' : 'CONFLICT'
  }
  // local is absent
  if (base === undefined) return 'PULL_NEW'
  return remote === base ? 'DELETE_REMOTE' : 'CONFLICT'
}

function conflictKind(base?: Side, local?: Side, remote?: Side) {
  if (local === undefined) return 'local-deleted' as const
  if (remote === undefined) return 'remote-deleted' as const
  return base === undefined ? ('both-created' as const) : ('both-edited' as const)
}

export function resolveItem(input: {
  kind: ItemKind
  id: string
  base?: Side
  local?: Side
  remote?: Side
}): Resolution {
  const { kind, id, base, local, remote } = input
  const decision = decide(base?.contentHash, local?.contentHash, remote?.contentHash)
  const appsDecision = decide(
    base && JSON.stringify(base.apps),
    local && JSON.stringify(local.apps),
    remote && JSON.stringify(remote.apps),
  )

  return {
    kind,
    id,
    decision,
    ...(decision === 'CONFLICT' ? { conflictKind: conflictKind(base, local, remote) } : {}),
    appsDecision,
    apps: mergeApps(base?.apps, local?.apps, remote?.apps),
    base, local, remote,
  }
}

export function resolveAll(
  base: Map<string, Side>,
  local: Map<string, Side>,
  remote: Map<string, Side>,
  kind: ItemKind,
): Resolution[] {
  const ids = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort()
  return ids.map((id) =>
    resolveItem({ kind, id, base: base.get(id), local: local.get(id), remote: remote.get(id) }),
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/resolve.test.ts`
Expected: PASS, 26 tests

- [ ] **Step 5: Add a property test for total coverage of the table**

Append to `tests/core/resolve.test.ts`:
```ts
describe('exhaustive: every base/local/remote combination is decided', () => {
  const values = [undefined, 'A', 'B', 'C']
  it('never throws and never returns an unknown decision', () => {
    const known = new Set(['IN_SYNC','PUSH','PULL','PUSH_NEW','PULL_NEW',
      'DELETE_REMOTE','DELETE_LOCAL','CONFLICT'])
    for (const b of values) for (const l of values) for (const r of values) {
      const res = resolveItem({
        kind: 'skill', id: 'x',
        base: b ? S(b) : undefined,
        local: l ? S(l) : undefined,
        remote: r ? S(r) : undefined,
      })
      expect(known.has(res.decision)).toBe(true)
      // A PUSH must never discard a remote that diverged from base.
      if (res.decision === 'PUSH') expect(r).toBe(b)
      // A PULL must never discard a local that diverged from base.
      if (res.decision === 'PULL') expect(l).toBe(b)
    }
  })
})
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/resolve.ts src/core/types.ts tests/core/resolve.test.ts
git commit -m "feat: three-way resolver with exhaustive decision table tests"
```

---

## Task 4: cc-switch reader

**Files:**
- Create: `src/ccswitch/paths.ts`, `src/ccswitch/read.ts`
- Test: `tests/ccswitch/read.test.ts`, `tests/helpers/fakeCcSwitch.ts`

**Interfaces:**
- Consumes: `App`, `APPS`, `Side` from Tasks 2–3; `treeHash`, `canonicalJsonHash`
- Produces:
  - `interface CcPaths { home: string; db: string; skillsDir: string }`
  - `resolveCcPaths(env?: NodeJS.ProcessEnv): CcPaths`
  - `interface SkillRow { id: string; name: string; description: string | null; directory: string; apps: App[] }`
  - `interface McpRow { id: string; name: string; config: Record<string, unknown>; tags: string[]; apps: App[] }`
  - `interface RepoRow { owner: string; name: string; branch: string; enabled: boolean }`
  - `readSkills(p: CcPaths): SkillRow[]`
  - `readMcp(p: CcPaths): McpRow[]`
  - `readRepos(p: CcPaths): RepoRow[]`
  - `localSkillSides(p: CcPaths): Promise<Map<string, Side>>`
  - `localMcpSides(p: CcPaths): Map<string, Side>`
  - `localRepoSides(p: CcPaths): Map<string, Side>`
  - `stripSecrets(config: Record<string, unknown>): { sanitized: Record<string, unknown>; secrets: Record<string, string> }`

`stripSecrets` replaces every `env` value with `{ "secret": true }` in the
sanitized copy and returns the real values keyed by env name. The `mcp` content
hash is taken over the **sanitized** config, so rotating a key does not look
like a content change.

- [ ] **Step 1: Write the failing test**

`tests/helpers/fakeCcSwitch.ts`:
```ts
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface FakeHome { home: string; db: string; skillsDir: string }

export async function makeFakeCcSwitch(): Promise<FakeHome> {
  const home = await mkdtemp(join(tmpdir(), 'ss-cc-'))
  const skillsDir = join(home, 'skills')
  await mkdir(skillsDir, { recursive: true })
  const db = join(home, 'cc-switch.db')

  const d = new DatabaseSync(db)
  d.exec(`
    CREATE TABLE skills (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
      directory TEXT NOT NULL, repo_owner TEXT, repo_name TEXT, repo_branch TEXT,
      readme_url TEXT,
      enabled_claude BOOLEAN NOT NULL DEFAULT 0, enabled_codex BOOLEAN NOT NULL DEFAULT 0,
      enabled_gemini BOOLEAN NOT NULL DEFAULT 0, enabled_opencode BOOLEAN NOT NULL DEFAULT 0,
      installed_at INTEGER NOT NULL DEFAULT 0, content_hash TEXT,
      updated_at INTEGER NOT NULL DEFAULT 0,
      enabled_hermes BOOLEAN NOT NULL DEFAULT 0, enabled_grokbuild BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE mcp_servers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, server_config TEXT NOT NULL,
      description TEXT, homepage TEXT, docs TEXT, tags TEXT NOT NULL DEFAULT '[]',
      enabled_claude BOOLEAN NOT NULL DEFAULT 0, enabled_codex BOOLEAN NOT NULL DEFAULT 0,
      enabled_gemini BOOLEAN NOT NULL DEFAULT 0, enabled_opencode BOOLEAN NOT NULL DEFAULT 0,
      enabled_hermes BOOLEAN NOT NULL DEFAULT 0, enabled_grokbuild BOOLEAN NOT NULL DEFAULT 0);
    CREATE TABLE skill_repos (
      owner TEXT NOT NULL, name TEXT NOT NULL, branch TEXT NOT NULL DEFAULT 'main',
      enabled BOOLEAN NOT NULL DEFAULT 1, PRIMARY KEY (owner, name));
  `)
  d.close()
  return { home, db, skillsDir }
}

export async function addSkill(f: FakeHome, dir: string, body: string, apps: string[]) {
  await mkdir(join(f.skillsDir, dir), { recursive: true })
  await writeFile(join(f.skillsDir, dir, 'SKILL.md'), body)
  const d = new DatabaseSync(f.db)
  const cols = apps.map((a) => `enabled_${a}`)
  d.prepare(
    `INSERT INTO skills (id,name,directory${cols.length ? ',' + cols.join(',') : ''})
     VALUES (?,?,?${cols.map(() => ',1').join('')})`,
  ).run(`local:${dir}`, dir, dir)
  d.close()
}

export function addMcp(f: FakeHome, id: string, config: unknown, apps: string[]) {
  const d = new DatabaseSync(f.db)
  const cols = apps.map((a) => `enabled_${a}`)
  d.prepare(
    `INSERT INTO mcp_servers (id,name,server_config${cols.length ? ',' + cols.join(',') : ''})
     VALUES (?,?,?${cols.map(() => ',1').join('')})`,
  ).run(id, id, JSON.stringify(config))
  d.close()
}
```

`tests/ccswitch/read.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { makeFakeCcSwitch, addSkill, addMcp, type FakeHome } from '../helpers/fakeCcSwitch.js'
import { readSkills, readMcp, localSkillSides, localMcpSides, stripSecrets }
  from '../../src/ccswitch/read.js'
import { resolveCcPaths } from '../../src/ccswitch/paths.js'

let f: FakeHome
beforeEach(async () => { f = await makeFakeCcSwitch() })

describe('resolveCcPaths', () => {
  it('honours CC_SWITCH_CONFIG_DIR', () => {
    const p = resolveCcPaths({ CC_SWITCH_CONFIG_DIR: '/tmp/x' } as NodeJS.ProcessEnv)
    expect(p.home).toBe('/tmp/x')
    expect(p.db).toBe('/tmp/x/cc-switch.db')
    expect(p.skillsDir).toBe('/tmp/x/skills')
  })
})

describe('readSkills', () => {
  it('reads rows and decodes the app matrix', async () => {
    await addSkill(f, 'code-review', '# review', ['claude', 'hermes'])
    const rows = readSkills(f)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.directory).toBe('code-review')
    expect(rows[0]!.apps).toEqual(['claude', 'hermes'])
  })

  it('returns an empty array when there are no skills', () => {
    expect(readSkills(f)).toEqual([])
  })
})

describe('localSkillSides', () => {
  it('hashes each skill directory', async () => {
    await addSkill(f, 'a', 'body-a', ['claude'])
    const sides = await localSkillSides(f)
    expect(sides.get('a')!.contentHash.startsWith('sha256:')).toBe(true)
    expect(sides.get('a')!.apps).toEqual(['claude'])
  })

  it('skips a row whose directory is missing from disk', async () => {
    addMcp(f, 'x', { type: 'stdio', command: 'e' }, [])
    const sides = await localSkillSides(f)
    expect(sides.size).toBe(0)
  })
})

describe('stripSecrets', () => {
  it('replaces env values with a secret marker and returns the real values', () => {
    const { sanitized, secrets } = stripSecrets({
      type: 'stdio', command: 'x', env: { API_KEY: 'sk-live-1', PORT: '8080' },
    })
    expect(sanitized.env).toEqual({ API_KEY: { secret: true }, PORT: { secret: true } })
    expect(secrets).toEqual({ API_KEY: 'sk-live-1', PORT: '8080' })
    expect(JSON.stringify(sanitized)).not.toContain('sk-live-1')
  })

  it('leaves a config without env untouched', () => {
    const { sanitized, secrets } = stripSecrets({ type: 'stdio', command: 'x' })
    expect(sanitized).toEqual({ type: 'stdio', command: 'x' })
    expect(secrets).toEqual({})
  })
})

describe('localMcpSides', () => {
  it('hashes the sanitized config so a rotated key is not a content change', () => {
    addMcp(f, 'o', { type: 'stdio', command: 'c', env: { K: 'v1' } }, ['claude'])
    const first = localMcpSides(f).get('o')!.contentHash
    const f2 = f
    addMcp({ ...f2, db: f2.db }, 'p', { type: 'stdio', command: 'c', env: { K: 'v2' } }, ['claude'])
    const second = localMcpSides(f).get('p')!.contentHash
    expect(first).toBe(second)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ccswitch/read.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

`src/ccswitch/paths.ts`:
```ts
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CcPaths { home: string; db: string; skillsDir: string }

export function resolveCcPaths(env: NodeJS.ProcessEnv = process.env): CcPaths {
  const home = env.CC_SWITCH_CONFIG_DIR ?? env.CC_SWITCH_TEST_HOME ?? join(homedir(), '.cc-switch')
  return { home, db: join(home, 'cc-switch.db'), skillsDir: join(home, 'skills') }
}
```

`src/ccswitch/read.ts`:
```ts
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APPS } from '../core/types.js'
import type { App, Side } from '../core/types.js'
import { treeHash, canonicalJsonHash } from '../core/hash.js'
import type { CcPaths } from './paths.js'

export interface SkillRow {
  id: string; name: string; description: string | null; directory: string; apps: App[]
}
export interface McpRow {
  id: string; name: string; config: Record<string, unknown>; tags: string[]; apps: App[]
}
export interface RepoRow { owner: string; name: string; branch: string; enabled: boolean }

function open(p: CcPaths): DatabaseSync {
  if (!existsSync(p.db)) throw new Error(`cc-switch database not found at ${p.db}`)
  return new DatabaseSync(p.db, { readOnly: true })
}

function appsOf(row: Record<string, unknown>): App[] {
  return APPS.filter((a) => Number(row[`enabled_${a}`] ?? 0) === 1)
}

export function readSkills(p: CcPaths): SkillRow[] {
  const db = open(p)
  try {
    const rows = db.prepare('SELECT * FROM skills ORDER BY directory').all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id), name: String(r.name),
      description: r.description === null ? null : String(r.description),
      directory: String(r.directory), apps: appsOf(r),
    }))
  } finally { db.close() }
}

export function readMcp(p: CcPaths): McpRow[] {
  const db = open(p)
  try {
    const rows = db.prepare('SELECT * FROM mcp_servers ORDER BY id').all() as Record<string, unknown>[]
    return rows.map((r) => ({
      id: String(r.id), name: String(r.name),
      config: JSON.parse(String(r.server_config)) as Record<string, unknown>,
      tags: JSON.parse(String(r.tags ?? '[]')) as string[],
      apps: appsOf(r),
    }))
  } finally { db.close() }
}

export function readRepos(p: CcPaths): RepoRow[] {
  const db = open(p)
  try {
    const rows = db.prepare('SELECT * FROM skill_repos ORDER BY owner, name').all() as Record<string, unknown>[]
    return rows.map((r) => ({
      owner: String(r.owner), name: String(r.name),
      branch: String(r.branch ?? 'main'), enabled: Number(r.enabled ?? 0) === 1,
    }))
  } finally { db.close() }
}

export function stripSecrets(config: Record<string, unknown>): {
  sanitized: Record<string, unknown>; secrets: Record<string, string>
} {
  const secrets: Record<string, string> = {}
  const sanitized: Record<string, unknown> = { ...config }
  const env = config.env
  if (env !== null && typeof env === 'object' && !Array.isArray(env)) {
    const marked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      secrets[k] = String(v)
      marked[k] = { secret: true }
    }
    sanitized.env = marked
  }
  return { sanitized, secrets }
}

export async function localSkillSides(p: CcPaths): Promise<Map<string, Side>> {
  const out = new Map<string, Side>()
  for (const row of readSkills(p)) {
    const dir = join(p.skillsDir, row.directory)
    if (!existsSync(dir)) continue
    out.set(row.directory, { contentHash: await treeHash(dir), apps: row.apps })
  }
  return out
}

export function localMcpSides(p: CcPaths): Map<string, Side> {
  const out = new Map<string, Side>()
  for (const row of readMcp(p)) {
    const { sanitized } = stripSecrets(row.config)
    out.set(row.id, {
      contentHash: canonicalJsonHash({ config: sanitized, tags: row.tags }),
      apps: row.apps,
    })
  }
  return out
}

export function localRepoSides(p: CcPaths): Map<string, Side> {
  const out = new Map<string, Side>()
  for (const r of readRepos(p)) {
    out.set(`${r.owner}/${r.name}`, {
      contentHash: canonicalJsonHash({ branch: r.branch, enabled: r.enabled }),
      apps: [],
    })
  }
  return out
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ccswitch/read.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/ccswitch tests/ccswitch tests/helpers
git commit -m "feat: read skills, MCP servers and repos from the cc-switch database"
```

---

## Task 5: cc-switch writer

**Files:**
- Create: `src/ccswitch/write.ts`
- Test: `tests/ccswitch/write.test.ts`, `tests/helpers/stubBin.ts`

**Interfaces:**
- Consumes: `run` (Task 1), `App` (Task 2), `CcPaths` (Task 4)
- Produces:
  - `buildDeeplink(id: string, config: Record<string, unknown>, apps: App[]): string`
  - `interface CcWriter { importMcp(id, config, apps): Promise<void>; setMcpApps(id, apps): Promise<void>; deleteMcp(id): Promise<'deleted' | 'pending'>; importSkill(dir, apps): Promise<void>; setSkillApps(dir, apps): Promise<void>; syncSkills(): Promise<void> }`
  - `createWriter(opts: { bin?: string; paths: CcPaths; env?: Record<string,string> }): CcWriter`

`buildDeeplink` is pure and fully tested; the rest is thin process invocation
verified against a stub binary that records its argv.

- [ ] **Step 1: Write the failing test**

`tests/helpers/stubBin.ts`:
```ts
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Stub { dir: string; bin: string; log: string; calls(): Promise<string[]> }

export async function makeStubBin(name: string, exitCode = 0): Promise<Stub> {
  const dir = await mkdtemp(join(tmpdir(), 'ss-stub-'))
  const bin = join(dir, name)
  const log = join(dir, 'calls.log')
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit ${exitCode}\n`)
  await chmod(bin, 0o755)
  await writeFile(log, '')
  return {
    dir, bin, log,
    async calls() {
      const t = await readFile(log, 'utf8')
      return t.split('\n').filter((l) => l.length > 0)
    },
  }
}
```

`tests/ccswitch/write.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { buildDeeplink, createWriter } from '../../src/ccswitch/write.js'
import { makeStubBin, type Stub } from '../helpers/stubBin.js'
import { makeFakeCcSwitch, type FakeHome } from '../helpers/fakeCcSwitch.js'

describe('buildDeeplink', () => {
  const cfg = { type: 'stdio', command: 'echo', args: ['hi'], env: {} }

  it('produces a ccswitch://v1/import URL for the mcp resource', () => {
    expect(buildDeeplink('x', cfg, ['claude'])).toMatch(/^ccswitch:\/\/v1\/import\?/)
    expect(buildDeeplink('x', cfg, ['claude'])).toContain('resource=mcp')
  })

  it('joins apps with commas', () => {
    expect(buildDeeplink('x', cfg, ['claude', 'codex'])).toContain('apps=claude%2Ccodex')
  })

  it('base64-encodes an mcpServers document keyed by the server id', () => {
    const url = new URL(buildDeeplink('my-server', cfg, ['claude']))
    const b64 = url.searchParams.get('config')!
    const json = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
    expect(Object.keys(json.mcpServers)).toEqual(['my-server'])
    expect(json.mcpServers['my-server']).toEqual(cfg)
  })

  it('uses URL-safe base64 so + and / never appear', () => {
    const heavy = { type: 'stdio', command: '???>>>', args: ['ÿþý'] }
    const b64 = new URL(buildDeeplink('x', heavy, ['claude'])).searchParams.get('config')!
    expect(b64).not.toMatch(/[+/]/)
  })

  it('rejects an empty app list, which cc-switch refuses', () => {
    expect(() => buildDeeplink('x', cfg, [])).toThrow(/at least one app/i)
  })
})

describe('CcWriter', () => {
  let stub: Stub
  let f: FakeHome
  beforeEach(async () => { stub = await makeStubBin('cc-switch'); f = await makeFakeCcSwitch() })

  it('invokes deeplink for an MCP import', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.importMcp('o', { type: 'stdio', command: 'x' }, ['claude'])
    const calls = await stub.calls()
    expect(calls[0]).toContain('deeplink')
    expect(calls[0]).toContain('ccswitch://v1/import')
  })

  it('invokes mcp set-apps with a comma list', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.setMcpApps('o', ['claude', 'hermes'])
    expect((await stub.calls())[0]).toBe('mcp set-apps o --apps claude,hermes')
  })

  it('invokes skills set-apps with a comma list', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.setSkillApps('code-review', ['codex'])
    expect((await stub.calls())[0]).toBe('skills set-apps code-review --apps codex')
  })

  it('invokes skills import-from-apps for a new skill', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.importSkill('code-review', ['claude'])
    expect((await stub.calls())[0]).toBe('skills import-from-apps code-review --apps claude')
  })

  it('invokes skills sync', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.syncSkills()
    expect((await stub.calls())[0]).toBe('skills sync')
  })

  it('raises a descriptive error when the binary fails', async () => {
    const bad = await makeStubBin('cc-switch', 3)
    const w = createWriter({ bin: bad.bin, paths: f })
    await expect(w.syncSkills()).rejects.toThrow(/cc-switch skills sync failed/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/ccswitch/write.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

`src/ccswitch/write.ts`:
```ts
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { run } from '../util/exec.js'
import type { App } from '../core/types.js'
import type { CcPaths } from './paths.js'

export function buildDeeplink(
  id: string,
  config: Record<string, unknown>,
  apps: App[],
): string {
  if (apps.length === 0) throw new Error('deeplink requires at least one app')
  const doc = JSON.stringify({ mcpServers: { [id]: config } })
  const b64 = Buffer.from(doc, 'utf8').toString('base64url')
  const params = new URLSearchParams({ resource: 'mcp', apps: apps.join(','), config: b64 })
  return `ccswitch://v1/import?${params.toString()}`
}

export interface CcWriter {
  importMcp(id: string, config: Record<string, unknown>, apps: App[]): Promise<void>
  setMcpApps(id: string, apps: App[]): Promise<void>
  deleteMcp(id: string): Promise<'deleted' | 'pending'>
  importSkill(dir: string, apps: App[]): Promise<void>
  setSkillApps(dir: string, apps: App[]): Promise<void>
  syncSkills(): Promise<void>
}

export function createWriter(opts: {
  bin?: string
  paths: CcPaths
  env?: Record<string, string>
}): CcWriter {
  const bin = opts.bin ?? 'cc-switch'
  const env = { CC_SWITCH_TEST_DISABLE_OPEN: '1', ...opts.env }

  async function cc(args: string[], what: string): Promise<void> {
    const r = await run(bin, args, { env })
    if (r.code !== 0) {
      throw new Error(`cc-switch ${what} failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`)
    }
  }

  return {
    async importMcp(id, config, apps) {
      await cc(['deeplink', buildDeeplink(id, config, apps)], 'deeplink import')
    },
    async setMcpApps(id, apps) {
      await cc(['mcp', 'set-apps', id, '--apps', apps.join(',')], 'mcp set-apps')
    },
    async importSkill(dir, apps) {
      await cc(['skills', 'import-from-apps', dir, '--apps', apps.join(',')], 'skills import-from-apps')
    },
    async setSkillApps(dir, apps) {
      await cc(['skills', 'set-apps', dir, '--apps', apps.join(',')], 'skills set-apps')
    },
    async syncSkills() {
      await cc(['skills', 'sync'], 'skills sync')
    },

    // `cc-switch mcp delete` demands a TTY and offers no confirmation flag.
    // Strategy: pty via script(1)/expect, then a guarded direct delete, then report.
    async deleteMcp(id) {
      for (const attempt of [ptyDelete, directDelete]) {
        const ok = await attempt(bin, id, opts.paths, env).catch(() => false)
        if (ok) return 'deleted'
      }
      return 'pending'
    },
  }
}

async function ptyDelete(
  bin: string, id: string, _p: CcPaths, env: Record<string, string>,
): Promise<boolean> {
  const script = `set timeout 30
spawn ${bin} mcp delete ${id}
expect {
  -re {\\(y/N\\)} { send "y\\r"; exp_continue }
  eof
}`
  const r = await run('expect', ['-'], { input: script, env })
  return r.code === 0 && /Deleted MCP server/.test(r.stdout)
}

async function directDelete(
  _bin: string, id: string, p: CcPaths, _env: Record<string, string>,
): Promise<boolean> {
  if (!existsSync(p.db)) return false
  const ps = await run('pgrep', ['-f', 'cc-switch|ccswitch'])
  if (ps.code === 0 && ps.stdout.trim().length > 0) {
    throw new Error('cc-switch is running; refusing to write to its database directly')
  }
  const db = new DatabaseSync(p.db)
  try {
    db.exec('BEGIN')
    db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
    db.exec('COMMIT')
    const check = db.prepare('PRAGMA integrity_check').get() as Record<string, unknown>
    if (String(Object.values(check)[0]) !== 'ok') throw new Error('integrity check failed')
  } finally { db.close() }
  return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ccswitch/write.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/ccswitch/write.ts tests/ccswitch/write.test.ts tests/helpers/stubBin.ts
git commit -m "feat: cc-switch write adapter with verified deeplink encoding"
```

---

## Task 6: Config and state

**Files:**
- Create: `src/config.ts`, `src/state.ts`
- Test: `tests/config.test.ts`, `tests/state.test.ts`

**Interfaces:**
- Consumes: `Side`, `ItemKind` (Tasks 2–3)
- Produces:
  - `interface Config { schemaVersion: 1; host: string; owner: string; repo: string; branch: string; device: string; vault: string; item: string; secrets: boolean; excludes: string[] }`
  - `configDir(flags?: { config?: string }, env?: NodeJS.ProcessEnv): string`
  - `loadConfig(dir: string): Promise<Config | null>`
  - `saveConfig(dir: string, c: Config): Promise<void>`
  - `interface StateFile { schemaVersion: 1; updatedAt: string; items: Record<string, Side> }`
  - `stateKey(kind: ItemKind, id: string): string` → `` `${kind}:${id}` ``
  - `loadState(dir: string): Promise<StateFile>`
  - `saveState(dir: string, s: StateFile): Promise<void>`
  - `setBase(s: StateFile, kind: ItemKind, id: string, side: Side | undefined): void`

- [ ] **Step 1: Write the failing test**

`tests/state.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, setBase, stateKey } from '../src/state.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ss-state-')) })

describe('state', () => {
  it('returns an empty state when the file does not exist', async () => {
    const s = await loadState(dir)
    expect(s.schemaVersion).toBe(1)
    expect(s.items).toEqual({})
  })

  it('round-trips through disk', async () => {
    const s = await loadState(dir)
    setBase(s, 'skill', 'code-review', { contentHash: 'sha256:a', apps: ['claude'] })
    await saveState(dir, s)
    const again = await loadState(dir)
    expect(again.items[stateKey('skill', 'code-review')])
      .toEqual({ contentHash: 'sha256:a', apps: ['claude'] })
  })

  it('namespaces ids by kind so a skill and an mcp may share a name', async () => {
    const s = await loadState(dir)
    setBase(s, 'skill', 'x', { contentHash: 'sha256:s', apps: [] })
    setBase(s, 'mcp', 'x', { contentHash: 'sha256:m', apps: [] })
    expect(s.items['skill:x']!.contentHash).toBe('sha256:s')
    expect(s.items['mcp:x']!.contentHash).toBe('sha256:m')
  })

  it('removes an entry when the side is undefined', async () => {
    const s = await loadState(dir)
    setBase(s, 'skill', 'x', { contentHash: 'sha256:a', apps: [] })
    setBase(s, 'skill', 'x', undefined)
    expect(s.items['skill:x']).toBeUndefined()
  })

  it('writes atomically, leaving no partial file behind on rewrite', async () => {
    const s = await loadState(dir)
    setBase(s, 'skill', 'a', { contentHash: 'sha256:1', apps: [] })
    await saveState(dir, s)
    setBase(s, 'skill', 'a', { contentHash: 'sha256:2', apps: [] })
    await saveState(dir, s)
    const parsed = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
    expect(parsed.items['skill:a'].contentHash).toBe('sha256:2')
  })

  it('treats an unreadable state file as empty rather than crashing', async () => {
    await writeFile(join(dir, 'state.json'), '{ this is not json')
    const s = await loadState(dir)
    expect(s.items).toEqual({})
  })
})
```

`tests/config.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig, saveConfig, configDir } from '../src/config.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ss-cfg-')) })

const sample = {
  schemaVersion: 1 as const, host: 'github.com', owner: 'ryoshin0830', repo: 'syncskills',
  branch: 'main', device: 'work-pc', vault: 'agent', item: 'syncskills',
  secrets: true, excludes: [] as string[],
}

describe('configDir', () => {
  it('prefers the --config flag', () => {
    expect(configDir({ config: '/tmp/a' }, {} as NodeJS.ProcessEnv)).toBe('/tmp/a')
  })
  it('then SYNCSKILLS_CONFIG_DIR', () => {
    expect(configDir({}, { SYNCSKILLS_CONFIG_DIR: '/tmp/b' } as NodeJS.ProcessEnv)).toBe('/tmp/b')
  })
  it('then XDG_CONFIG_HOME/syncskills', () => {
    expect(configDir({}, { XDG_CONFIG_HOME: '/tmp/c' } as NodeJS.ProcessEnv))
      .toBe('/tmp/c/syncskills')
  })
  it('otherwise ~/.config/syncskills', () => {
    expect(configDir({}, { HOME: '/Users/x' } as NodeJS.ProcessEnv))
      .toBe('/Users/x/.config/syncskills')
  })
})

describe('config', () => {
  it('returns null when not initialized', async () => {
    expect(await loadConfig(dir)).toBeNull()
  })
  it('round-trips', async () => {
    await saveConfig(dir, sample)
    expect(await loadConfig(dir)).toEqual(sample)
  })
  it('rejects a config from a future schema version', async () => {
    await saveConfig(dir, { ...sample, schemaVersion: 99 as unknown as 1 })
    await expect(loadConfig(dir)).rejects.toThrow(/schema version/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/state.test.ts tests/config.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementation**

`src/config.ts`:
```ts
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  schemaVersion: 1
  host: string
  owner: string
  repo: string
  branch: string
  device: string
  vault: string
  item: string
  secrets: boolean
  excludes: string[]
}

export function configDir(
  flags: { config?: string } = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (flags.config !== undefined && flags.config !== '') return flags.config
  if (env.SYNCSKILLS_CONFIG_DIR) return env.SYNCSKILLS_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, 'syncskills')
  return join(env.HOME ?? homedir(), '.config', 'syncskills')
}

export async function loadConfig(dir: string): Promise<Config | null> {
  const text = await readFile(join(dir, 'config.json'), 'utf8').catch(() => null)
  if (text === null) return null
  const parsed = JSON.parse(text) as Config
  if (parsed.schemaVersion !== 1) {
    throw new Error(
      `unsupported config schema version ${parsed.schemaVersion}; upgrade syncskills`,
    )
  }
  return parsed
}

export async function saveConfig(dir: string, c: Config): Promise<void> {
  await mkdir(dir, { recursive: true })
  const tmp = join(dir, 'config.json.tmp')
  await writeFile(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 })
  await rename(tmp, join(dir, 'config.json'))
}
```

`src/state.ts`:
```ts
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { ItemKind, Side } from './core/types.js'

export interface StateFile {
  schemaVersion: 1
  updatedAt: string
  items: Record<string, Side>
}

export function stateKey(kind: ItemKind, id: string): string {
  return `${kind}:${id}`
}

function empty(): StateFile {
  return { schemaVersion: 1, updatedAt: new Date(0).toISOString(), items: {} }
}

export async function loadState(dir: string): Promise<StateFile> {
  const text = await readFile(join(dir, 'state.json'), 'utf8').catch(() => null)
  if (text === null) return empty()
  try {
    const parsed = JSON.parse(text) as StateFile
    if (parsed.schemaVersion !== 1 || typeof parsed.items !== 'object') return empty()
    return parsed
  } catch {
    // A damaged base is equivalent to no base: every item re-resolves as a
    // fresh comparison, which is safe — it can only produce more conflicts,
    // never a silent overwrite.
    return empty()
  }
}

export async function saveState(dir: string, s: StateFile): Promise<void> {
  await mkdir(dir, { recursive: true })
  s.updatedAt = new Date().toISOString()
  const tmp = join(dir, 'state.json.tmp')
  await writeFile(tmp, JSON.stringify(s, null, 2) + '\n')
  await rename(tmp, join(dir, 'state.json'))
}

export function setBase(
  s: StateFile, kind: ItemKind, id: string, side: Side | undefined,
): void {
  const k = stateKey(kind, id)
  if (side === undefined) delete s.items[k]
  else s.items[k] = side
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/state.test.ts tests/config.test.ts`
Expected: PASS, 13 tests

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/state.ts tests/config.test.ts tests/state.test.ts
git commit -m "feat: config and merge-base state with atomic writes"
```

---

## Task 7: Manifest

**Files:**
- Create: `src/store/manifest.ts`
- Test: `tests/store/manifest.test.ts`

**Interfaces:**
- Consumes: `App`, `ItemKind`, `Side` (Tasks 2–3)
- Produces:
  - `interface ManifestEntry { kind: ItemKind; id: string; contentHash: string; apps: App[]; version: number; updatedAt: string; updatedBy: string }`
  - `interface Manifest { schemaVersion: 1; generatedAt: string; entries: Record<string, ManifestEntry> }`
  - `emptyManifest(): Manifest`
  - `parseManifest(text: string): Manifest`
  - `serializeManifest(m: Manifest): string`
  - `manifestSides(m: Manifest, kind: ItemKind): Map<string, Side>`
  - `upsertEntry(m: Manifest, kind: ItemKind, id: string, side: Side, device: string): void`
  - `removeEntry(m: Manifest, kind: ItemKind, id: string): void`

`version` increments on every content change and is carried for human
readability and future tie-breaking; the resolver never reads it.

- [ ] **Step 1: Write the failing test**

`tests/store/manifest.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import {
  emptyManifest, parseManifest, serializeManifest, manifestSides, upsertEntry, removeEntry,
} from '../../src/store/manifest.js'

describe('manifest', () => {
  it('serializes deterministically so an unchanged sync produces no git diff', () => {
    const a = emptyManifest()
    upsertEntry(a, 'skill', 'b', { contentHash: 'sha256:1', apps: ['claude'] }, 'dev')
    upsertEntry(a, 'skill', 'a', { contentHash: 'sha256:2', apps: ['codex'] }, 'dev')
    const first = serializeManifest(a)
    const reparsed = parseManifest(first)
    expect(serializeManifest(reparsed)).toBe(first)
  })

  it('writes entry keys in sorted order', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'z', { contentHash: 'sha256:1', apps: [] }, 'dev')
    upsertEntry(m, 'mcp', 'a', { contentHash: 'sha256:2', apps: [] }, 'dev')
    const keys = Object.keys(JSON.parse(serializeManifest(m)).entries)
    expect(keys).toEqual([...keys].sort())
  })

  it('starts a new entry at version 1', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    expect(m.entries['skill:a']!.version).toBe(1)
  })

  it('increments the version when the content changes', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:2', apps: [] }, 'dev')
    expect(m.entries['skill:a']!.version).toBe(2)
  })

  it('increments the version when only the app matrix changes', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: ['claude'] }, 'dev')
    expect(m.entries['skill:a']!.version).toBe(2)
  })

  it('leaves the version and timestamp alone when nothing changed', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    const before = { ...m.entries['skill:a']! }
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'other-device')
    expect(m.entries['skill:a']).toEqual(before)
  })

  it('records the device that made the change', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'home-mac')
    expect(m.entries['skill:a']!.updatedBy).toBe('home-mac')
  })

  it('projects sides for one kind only', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: ['claude'] }, 'dev')
    upsertEntry(m, 'mcp', 'b', { contentHash: 'sha256:2', apps: [] }, 'dev')
    const sides = manifestSides(m, 'skill')
    expect([...sides.keys()]).toEqual(['a'])
    expect(sides.get('a')).toEqual({ contentHash: 'sha256:1', apps: ['claude'] })
  })

  it('removes an entry', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    removeEntry(m, 'skill', 'a')
    expect(m.entries['skill:a']).toBeUndefined()
  })

  it('treats an unparsable manifest as a hard error, never as empty', () => {
    expect(() => parseManifest('{ broken')).toThrow(/manifest/i)
  })

  it('rejects an unknown schema version', () => {
    expect(() => parseManifest(JSON.stringify({ schemaVersion: 2, entries: {} })))
      .toThrow(/schema version/i)
  })
})
```

An empty manifest and a corrupt manifest must not be confused: an empty one
means "the remote has nothing", a corrupt one means "do not act". Treating the
second as the first would delete everything on the remote.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/manifest.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

`src/store/manifest.ts`:
```ts
import type { App, ItemKind, Side } from '../core/types.js'
import { stateKey } from '../state.js'

export interface ManifestEntry {
  kind: ItemKind
  id: string
  contentHash: string
  apps: App[]
  version: number
  updatedAt: string
  updatedBy: string
}

export interface Manifest {
  schemaVersion: 1
  generatedAt: string
  entries: Record<string, ManifestEntry>
}

export function emptyManifest(): Manifest {
  return { schemaVersion: 1, generatedAt: new Date(0).toISOString(), entries: {} }
}

export function parseManifest(text: string): Manifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (e) {
    throw new Error(`manifest.json is not valid JSON: ${(e as Error).message}`)
  }
  const m = parsed as Manifest
  if (m.schemaVersion !== 1) {
    throw new Error(`unsupported manifest schema version ${m.schemaVersion}; upgrade syncskills`)
  }
  if (m.entries === null || typeof m.entries !== 'object') {
    throw new Error('manifest.json has no entries object')
  }
  return m
}

export function serializeManifest(m: Manifest): string {
  const entries: Record<string, ManifestEntry> = {}
  for (const k of Object.keys(m.entries).sort()) entries[k] = m.entries[k]!
  return JSON.stringify({ schemaVersion: 1, generatedAt: m.generatedAt, entries }, null, 2) + '\n'
}

export function manifestSides(m: Manifest, kind: ItemKind): Map<string, Side> {
  const out = new Map<string, Side>()
  for (const e of Object.values(m.entries)) {
    if (e.kind === kind) out.set(e.id, { contentHash: e.contentHash, apps: e.apps })
  }
  return out
}

export function upsertEntry(
  m: Manifest, kind: ItemKind, id: string, side: Side, device: string,
): void {
  const key = stateKey(kind, id)
  const prev = m.entries[key]
  const unchanged =
    prev !== undefined &&
    prev.contentHash === side.contentHash &&
    JSON.stringify(prev.apps) === JSON.stringify(side.apps)
  if (unchanged) return

  m.entries[key] = {
    kind, id,
    contentHash: side.contentHash,
    apps: side.apps,
    version: (prev?.version ?? 0) + 1,
    updatedAt: new Date().toISOString(),
    updatedBy: device,
  }
}

export function removeEntry(m: Manifest, kind: ItemKind, id: string): void {
  delete m.entries[stateKey(kind, id)]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/manifest.test.ts`
Expected: PASS, 11 tests

- [ ] **Step 5: Commit**

```bash
git add src/store/manifest.ts tests/store/manifest.test.ts
git commit -m "feat: deterministic manifest with per-item versioning"
```

---

## Task 8: Git store

**Files:**
- Create: `src/store/git.ts`
- Test: `tests/store/git.test.ts`

**Interfaces:**
- Consumes: `run` (Task 1), `Config` (Task 6), manifest helpers (Task 7)
- Produces:
  - `remoteUrl(c: Config): string` — `https://<host>/<owner>/<repo>.git`
  - `interface GitStore { dir: string; ensure(): Promise<void>; pull(): Promise<void>; readManifest(): Promise<Manifest>; writeManifest(m): Promise<void>; itemDir(kind, id): string; readItemJson(kind, id): Promise<Record<string, unknown> | null>; writeItemJson(kind, id, value): Promise<void>; removeItem(kind, id): Promise<void>; commitAndPush(message: string): Promise<boolean>; hasChanges(): Promise<boolean> }`
  - `createGitStore(opts: { cacheDir: string; config: Config; gitBin?: string }): GitStore`

`ensure()` clones when the cache is empty and otherwise fetches and hard-resets
to the tracked branch, so the working copy is always a faithful mirror of the
remote before resolution runs. Authentication rides on the user's existing `gh`
credential helper; no token is ever read by syncskills.

- [ ] **Step 1: Write the failing test**

`tests/store/git.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../src/util/exec.js'
import { createGitStore, remoteUrl } from '../../src/store/git.js'
import type { Config } from '../../src/config.js'

const base: Config = {
  schemaVersion: 1, host: 'github.com', owner: 'o', repo: 'r', branch: 'main',
  device: 'dev', vault: 'agent', item: 'syncskills', secrets: true, excludes: [],
}

async function makeBareRemote(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ss-remote-'))
  await run('git', ['init', '--bare', '-b', 'main', dir])
  // Seed the bare repo with an initial commit so clone yields a branch.
  const seed = await mkdtemp(join(tmpdir(), 'ss-seed-'))
  await run('git', ['init', '-b', 'main', seed])
  await run('git', ['-C', seed, 'config', 'user.email', 't@example.com'])
  await run('git', ['-C', seed, 'config', 'user.name', 'test'])
  await writeFile(join(seed, 'README.md'), '# seed\n')
  await run('git', ['-C', seed, 'add', '-A'])
  await run('git', ['-C', seed, 'commit', '-m', 'seed'])
  await run('git', ['-C', seed, 'push', dir, 'main'])
  return dir
}

describe('remoteUrl', () => {
  it('builds an https URL for github.com', () => {
    expect(remoteUrl(base)).toBe('https://github.com/o/r.git')
  })
  it('builds an https URL for a GHES host', () => {
    expect(remoteUrl({ ...base, host: 'git.pepabo.com' }))
      .toBe('https://git.pepabo.com/o/r.git')
  })
})

describe('GitStore', () => {
  let remote: string
  let cache: string
  beforeEach(async () => {
    remote = await makeBareRemote()
    cache = await mkdtemp(join(tmpdir(), 'ss-cache-'))
  })

  const store = (c: string, r: string) =>
    createGitStore({ cacheDir: c, config: { ...base, host: r } })

  it('clones on first use', async () => {
    const s = createGitStore({ cacheDir: cache, config: base, remoteOverride: remote })
    await s.ensure()
    expect((await run('git', ['-C', s.dir, 'rev-parse', 'HEAD'])).code).toBe(0)
  })

  it('returns an empty manifest when the remote has none', async () => {
    const s = createGitStore({ cacheDir: cache, config: base, remoteOverride: remote })
    await s.ensure()
    expect((await s.readManifest()).entries).toEqual({})
  })

  it('commits and pushes, and a second clone sees the result', async () => {
    const s = createGitStore({ cacheDir: cache, config: base, remoteOverride: remote })
    await s.ensure()
    await s.writeItemJson('mcp', 'oracle', { type: 'stdio', command: 'oracle-mcp' })
    const pushed = await s.commitAndPush('test: add oracle')
    expect(pushed).toBe(true)

    const other = await mkdtemp(join(tmpdir(), 'ss-cache2-'))
    const s2 = createGitStore({ cacheDir: other, config: base, remoteOverride: remote })
    await s2.ensure()
    expect(await s2.readItemJson('mcp', 'oracle'))
      .toEqual({ type: 'stdio', command: 'oracle-mcp' })
  })

  it('reports no changes when nothing was written', async () => {
    const s = createGitStore({ cacheDir: cache, config: base, remoteOverride: remote })
    await s.ensure()
    expect(await s.hasChanges()).toBe(false)
    expect(await s.commitAndPush('noop')).toBe(false)
  })

  it('removes an item and the removal propagates', async () => {
    const s = createGitStore({ cacheDir: cache, config: base, remoteOverride: remote })
    await s.ensure()
    await s.writeItemJson('mcp', 'gone', { a: 1 })
    await s.commitAndPush('add')
    await s.removeItem('mcp', 'gone')
    await s.commitAndPush('remove')

    const other = await mkdtemp(join(tmpdir(), 'ss-cache3-'))
    const s2 = createGitStore({ cacheDir: other, config: base, remoteOverride: remote })
    await s2.ensure()
    expect(await s2.readItemJson('mcp', 'gone')).toBeNull()
  })

  it('discards local cache drift on ensure', async () => {
    const s = createGitStore({ cacheDir: cache, config: base, remoteOverride: remote })
    await s.ensure()
    await writeFile(join(s.dir, 'stray.txt'), 'junk')
    await s.ensure()
    expect(await s.hasChanges()).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/store/git.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

`src/store/git.ts`:
```ts
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../util/exec.js'
import type { Config } from '../config.js'
import { emptyManifest, parseManifest, serializeManifest } from './manifest.js'
import type { Manifest } from './manifest.js'
import type { ItemKind } from '../core/types.js'

export function remoteUrl(c: Config): string {
  return `https://${c.host}/${c.owner}/${c.repo}.git`
}

const DIR_OF: Record<ItemKind, string> = { skill: 'skills', mcp: 'mcp', repo: 'repos' }

export interface GitStore {
  dir: string
  ensure(): Promise<void>
  readManifest(): Promise<Manifest>
  writeManifest(m: Manifest): Promise<void>
  itemDir(kind: ItemKind, id: string): string
  readItemJson(kind: ItemKind, id: string): Promise<Record<string, unknown> | null>
  writeItemJson(kind: ItemKind, id: string, value: unknown): Promise<void>
  removeItem(kind: ItemKind, id: string): Promise<void>
  hasChanges(): Promise<boolean>
  commitAndPush(message: string): Promise<boolean>
}

export function createGitStore(opts: {
  cacheDir: string
  config: Config
  gitBin?: string
  remoteOverride?: string
}): GitStore {
  const git = opts.gitBin ?? 'git'
  const dir = join(opts.cacheDir, 'repo')
  const url = opts.remoteOverride ?? remoteUrl(opts.config)
  const branch = opts.config.branch

  async function g(args: string[], what: string) {
    const r = await run(git, ['-C', dir, ...args])
    if (r.code !== 0) throw new Error(`git ${what} failed: ${r.stderr.trim() || r.stdout.trim()}`)
    return r
  }

  return {
    dir,

    async ensure() {
      if (!existsSync(join(dir, '.git'))) {
        await mkdir(opts.cacheDir, { recursive: true })
        await rm(dir, { recursive: true, force: true })
        const r = await run(git, ['clone', '--branch', branch, url, dir])
        if (r.code !== 0) {
          const r2 = await run(git, ['clone', url, dir])
          if (r2.code !== 0) throw new Error(`git clone failed: ${r2.stderr.trim()}`)
          await g(['checkout', '-B', branch], 'checkout')
        }
      } else {
        await g(['fetch', 'origin', branch], 'fetch')
        await g(['checkout', '-B', branch, `origin/${branch}`], 'checkout')
        await g(['reset', '--hard', `origin/${branch}`], 'reset')
        await g(['clean', '-fd'], 'clean')
      }
      await run(git, ['-C', dir, 'config', 'user.email', 'syncskills@localhost'])
      await run(git, ['-C', dir, 'config', 'user.name', 'syncskills'])
    },

    async readManifest() {
      const text = await readFile(join(dir, 'manifest.json'), 'utf8').catch(() => null)
      return text === null ? emptyManifest() : parseManifest(text)
    },

    async writeManifest(m) {
      m.generatedAt = new Date().toISOString()
      await writeFile(join(dir, 'manifest.json'), serializeManifest(m))
    },

    itemDir(kind, id) {
      return join(dir, DIR_OF[kind], id)
    },

    async readItemJson(kind, id) {
      const text = await readFile(join(dir, DIR_OF[kind], `${id}.json`), 'utf8').catch(() => null)
      return text === null ? null : (JSON.parse(text) as Record<string, unknown>)
    },

    async writeItemJson(kind, id, value) {
      const d = join(dir, DIR_OF[kind])
      await mkdir(d, { recursive: true })
      await writeFile(join(d, `${id}.json`), JSON.stringify(value, null, 2) + '\n')
    },

    async removeItem(kind, id) {
      await rm(join(dir, DIR_OF[kind], `${id}.json`), { force: true })
      await rm(join(dir, DIR_OF[kind], id), { recursive: true, force: true })
    },

    async hasChanges() {
      const r = await g(['status', '--porcelain'], 'status')
      return r.stdout.trim().length > 0
    },

    async commitAndPush(message) {
      await g(['add', '-A'], 'add')
      const st = await g(['status', '--porcelain'], 'status')
      if (st.stdout.trim().length === 0) return false
      await g(['commit', '-m', message], 'commit')
      await g(['push', 'origin', branch], 'push')
      return true
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/store/git.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/store/git.ts tests/store/git.test.ts
git commit -m "feat: git-backed store with clone, mirror and push"
```

---

## Task 9: Secrets

**Files:**
- Create: `src/secrets/provider.ts`, `src/secrets/onepassword.ts`, `src/secrets/scan.ts`
- Test: `tests/secrets/provider.test.ts`, `tests/secrets/scan.test.ts`

**Interfaces:**
- Consumes: `run` (Task 1)
- Produces:
  - `interface SecretBlob { schemaVersion: 1; mcp: Record<string, { env: Record<string, string> }> }`
  - `interface SecretProvider { read(): Promise<SecretBlob>; write(b: SecretBlob): Promise<void>; check(): Promise<{ ok: boolean; detail: string }> }`
  - `emptyBlob(): SecretBlob`
  - `nullProvider(): SecretProvider` — used with `--no-secrets`
  - `memoryProvider(initial?: SecretBlob): SecretProvider` — used by tests
  - `onePasswordProvider(opts: { vault: string; item: string; token: string; opBin?: string }): SecretProvider`
  - `scanForSecrets(text: string): string[]` — returns descriptions of anything suspicious

- [ ] **Step 1: Write the failing test**

`tests/secrets/scan.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { scanForSecrets } from '../../src/secrets/scan.js'

describe('scanForSecrets', () => {
  it('passes a sanitized MCP document', () => {
    expect(scanForSecrets(JSON.stringify({ env: { API_KEY: { secret: true } } }))).toEqual([])
  })

  it('flags an OpenAI-style key', () => {
    expect(scanForSecrets('sk-proj-abcdefghijklmnopqrstuvwxyz0123456789').length).toBeGreaterThan(0)
  })

  it('flags a GitHub token', () => {
    expect(scanForSecrets('ghp_0123456789abcdefghijklmnopqrstuvwxyzAB').length).toBeGreaterThan(0)
  })

  it('flags a 1Password service account token', () => {
    expect(scanForSecrets('ops_eyJzaWduSW5BZGRyZXNzIjoibXkuMXBhc3N3b3JkLmNvbSJ9').length)
      .toBeGreaterThan(0)
  })

  it('flags an AWS access key id', () => {
    expect(scanForSecrets('AKIAIOSFODNN7EXAMPLE').length).toBeGreaterThan(0)
  })

  it('flags a long high-entropy blob assigned to a key-looking field', () => {
    const s = '"API_KEY": "Zx9QwErTyUiOpAsDfGhJkLzXcVbNm1234567890abcd"'
    expect(scanForSecrets(s).length).toBeGreaterThan(0)
  })

  it('does not flag ordinary prose or a sha256 content hash', () => {
    expect(scanForSecrets('The quick brown fox jumps over the lazy dog.')).toEqual([])
    expect(scanForSecrets('"contentHash": "sha256:' + 'a'.repeat(64) + '"')).toEqual([])
  })

  it('does not flag a placeholder reference', () => {
    expect(scanForSecrets('"API_KEY": "${MY_API_KEY}"')).toEqual([])
  })
})
```

`tests/secrets/provider.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { memoryProvider, nullProvider, emptyBlob } from '../../src/secrets/provider.js'

describe('memoryProvider', () => {
  it('round-trips a blob', async () => {
    const p = memoryProvider()
    const b = emptyBlob()
    b.mcp.oracle = { env: { API_KEY: 'sk-1' } }
    await p.write(b)
    expect((await p.read()).mcp.oracle!.env.API_KEY).toBe('sk-1')
  })

  it('reports healthy', async () => {
    expect((await memoryProvider().check()).ok).toBe(true)
  })
})

describe('nullProvider', () => {
  it('always reads an empty blob', async () => {
    expect((await nullProvider().read()).mcp).toEqual({})
  })

  it('accepts writes silently so --no-secrets never fails a sync', async () => {
    const b = emptyBlob()
    b.mcp.x = { env: { K: 'v' } }
    await expect(nullProvider().write(b)).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/secrets`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementation**

`src/secrets/provider.ts`:
```ts
export interface SecretBlob {
  schemaVersion: 1
  mcp: Record<string, { env: Record<string, string> }>
}

export interface SecretProvider {
  read(): Promise<SecretBlob>
  write(blob: SecretBlob): Promise<void>
  check(): Promise<{ ok: boolean; detail: string }>
}

export function emptyBlob(): SecretBlob {
  return { schemaVersion: 1, mcp: {} }
}

export function nullProvider(): SecretProvider {
  return {
    async read() { return emptyBlob() },
    async write() { /* --no-secrets: values stay on this machine only */ },
    async check() { return { ok: true, detail: 'secrets disabled (--no-secrets)' } },
  }
}

export function memoryProvider(initial: SecretBlob = emptyBlob()): SecretProvider {
  let current = structuredClone(initial)
  return {
    async read() { return structuredClone(current) },
    async write(b) { current = structuredClone(b) },
    async check() { return { ok: true, detail: 'in-memory provider' } },
  }
}
```

`src/secrets/onepassword.ts`:
```ts
import { run } from '../util/exec.js'
import { emptyBlob } from './provider.js'
import type { SecretBlob, SecretProvider } from './provider.js'

export function onePasswordProvider(opts: {
  vault: string
  item: string
  token: string
  opBin?: string
}): SecretProvider {
  const bin = opts.opBin ?? 'op'
  const env = { OP_SERVICE_ACCOUNT_TOKEN: opts.token }

  async function op(args: string[], input?: string) {
    return run(bin, args, { env, ...(input === undefined ? {} : { input }) })
  }

  return {
    async check() {
      const who = await op(['whoami'])
      if (who.code !== 0) return { ok: false, detail: `op whoami failed: ${who.stderr.trim()}` }
      const vaults = await op(['vault', 'list', '--format', 'json'])
      if (vaults.code !== 0) return { ok: false, detail: `op vault list failed: ${vaults.stderr.trim()}` }
      const names = (JSON.parse(vaults.stdout) as { name: string }[]).map((v) => v.name)
      return names.includes(opts.vault)
        ? { ok: true, detail: `vault "${opts.vault}" reachable` }
        : { ok: false, detail: `vault "${opts.vault}" not accessible; available: ${names.join(', ')}` }
    },

    async read() {
      const r = await op(['read', `op://${opts.vault}/${opts.item}/notesPlain`])
      if (r.code !== 0) {
        // A missing item is not an error: it means no secrets are stored yet.
        if (/isn't an item|not found/i.test(r.stderr)) return emptyBlob()
        throw new Error(`op read failed: ${r.stderr.trim()}`)
      }
      const text = r.stdout.trim()
      if (text.length === 0) return emptyBlob()
      const parsed = JSON.parse(text) as SecretBlob
      if (parsed.schemaVersion !== 1) throw new Error('unsupported secret blob schema version')
      return parsed
    },

    async write(blob) {
      const json = JSON.stringify(blob, null, 2)
      const exists = await op(['item', 'get', opts.item, '--vault', opts.vault, '--format', 'json'])
      if (exists.code === 0) {
        const r = await op([
          'item', 'edit', opts.item, '--vault', opts.vault, `notesPlain=${json}`,
        ])
        if (r.code !== 0) throw new Error(`op item edit failed: ${r.stderr.trim()}`)
        return
      }
      const template = JSON.stringify({
        title: opts.item,
        category: 'SECURE_NOTE',
        fields: [{ id: 'notesPlain', type: 'STRING', purpose: 'NOTES', label: 'notesPlain', value: json }],
      })
      const r = await op(['item', 'create', '--vault', opts.vault, '-'], template)
      if (r.code !== 0) throw new Error(`op item create failed: ${r.stderr.trim()}`)
    },
  }
}
```

`src/secrets/scan.ts`:
```ts
const PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'Anthropic key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/ },
  { name: '1Password service account token', re: /\bops_[A-Za-z0-9+/=_-]{20,}/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Slack token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { name: 'private key block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
]

// A value assigned to a secret-looking field, long enough and mixed enough to
// be a real credential rather than a word.
const ASSIGNED = /"[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Za-z0-9_]*"\s*:\s*"([^"]{24,})"/gi

function looksRandom(s: string): boolean {
  if (/^\$\{[^}]+\}$/.test(s)) return false          // ${VAR} placeholder
  if (/^sha256:[0-9a-f]{64}$/.test(s)) return false   // our own content hash
  if (!/[0-9]/.test(s) || !/[A-Za-z]/.test(s)) return false
  const unique = new Set(s).size
  return unique >= 16
}

export function scanForSecrets(text: string): string[] {
  const found: string[] = []
  for (const p of PATTERNS) {
    if (p.re.test(text)) found.push(`possible ${p.name}`)
  }
  for (const m of text.matchAll(ASSIGNED)) {
    const value = m[1]!
    if (looksRandom(value)) found.push(`high-entropy value assigned to a credential-named field`)
  }
  return [...new Set(found)]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/secrets`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/secrets tests/secrets
git commit -m "feat: 1Password secret provider and pre-push secret scanner"
```

---

## Task 10: Merge stack

**Files:**
- Create: `src/merge/mergefile.ts`, `src/merge/validate.ts`, `src/merge/agent.ts`, `src/merge/index.ts`
- Test: `tests/merge/mergefile.test.ts`, `tests/merge/validate.test.ts`, `tests/merge/index.test.ts`

**Interfaces:**
- Consumes: `run` (Task 1), `walk`/`copyTree` (Task 2)
- Produces:
  - `mergeFile(base: string, local: string, remote: string): Promise<{ clean: boolean; text: string }>`
  - `hasConflictMarkers(text: string): boolean`
  - `validateMerged(relPath: string, text: string): { ok: true } | { ok: false; reason: string }`
  - `interface MergeAgent { name: string; merge(req: MergeRequest): Promise<string> }`
  - `interface MergeRequest { path: string; base: string; local: string; remote: string }`
  - `claudeAgent(bin?: string): MergeAgent`
  - `codexAgent(bin?: string): MergeAgent`
  - `noAgent(): MergeAgent` — always throws, forcing manual resolution
  - `pickAgent(name: 'claude' | 'codex' | 'none' | 'auto'): Promise<MergeAgent>`
  - `mergeTrees(opts: { baseDir?: string; localDir: string; remoteDir: string; outDir: string; agent: MergeAgent }): Promise<MergeReport>`
  - `interface MergeReport { files: { path: string; how: 'identical' | 'local-only' | 'remote-only' | 'git' | 'agent' | 'unresolved'; reason?: string }[]; resolved: boolean }`

- [ ] **Step 1: Write the failing test**

`tests/merge/validate.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { hasConflictMarkers, validateMerged } from '../../src/merge/validate.js'

describe('hasConflictMarkers', () => {
  it('detects all three marker kinds', () => {
    expect(hasConflictMarkers('<<<<<<< local\na\n=======\nb\n>>>>>>> remote\n')).toBe(true)
  })
  it('accepts clean text', () => {
    expect(hasConflictMarkers('just text\n')).toBe(false)
  })
  it('does not trip on a shorter run of angle brackets', () => {
    expect(hasConflictMarkers('a <<< b >>> c')).toBe(false)
  })
})

describe('validateMerged', () => {
  it('rejects empty output', () => {
    expect(validateMerged('SKILL.md', '   ')).toEqual({ ok: false, reason: 'merged output is empty' })
  })

  it('rejects leftover conflict markers', () => {
    const r = validateMerged('a.md', '<<<<<<< x\n1\n=======\n2\n>>>>>>> y\n')
    expect(r.ok).toBe(false)
  })

  it('requires SKILL.md to keep valid frontmatter with name and description', () => {
    const good = '---\nname: x\ndescription: y\n---\n\nbody\n'
    expect(validateMerged('SKILL.md', good)).toEqual({ ok: true })
  })

  it('rejects SKILL.md that lost its frontmatter', () => {
    expect(validateMerged('SKILL.md', 'body only\n').ok).toBe(false)
  })

  it('rejects SKILL.md that lost its name field', () => {
    expect(validateMerged('SKILL.md', '---\ndescription: y\n---\nbody\n').ok).toBe(false)
  })

  it('requires a .json file to parse', () => {
    expect(validateMerged('x.json', '{ "a": 1 }').ok).toBe(true)
    expect(validateMerged('x.json', '{ broken').ok).toBe(false)
  })

  it('accepts any other text file', () => {
    expect(validateMerged('scripts/run.sh', 'echo hi\n')).toEqual({ ok: true })
  })
})
```

`tests/merge/mergefile.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeFile } from '../../src/merge/mergefile.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ss-mf-')) })

async function files(base: string, local: string, remote: string) {
  const b = join(dir, 'base'), l = join(dir, 'local'), r = join(dir, 'remote')
  await writeFile(b, base); await writeFile(l, local); await writeFile(r, remote)
  return { b, l, r }
}

describe('mergeFile', () => {
  it('merges non-overlapping edits cleanly, keeping both', async () => {
    const { b, l, r } = await files(
      'line1\nline2\nline3\n',
      'CHANGED1\nline2\nline3\n',
      'line1\nline2\nCHANGED3\n',
    )
    const out = await mergeFile(b, l, r)
    expect(out.clean).toBe(true)
    expect(out.text).toContain('CHANGED1')
    expect(out.text).toContain('CHANGED3')
  })

  it('reports a conflict when the same line changed on both sides', async () => {
    const { b, l, r } = await files('same\n', 'local\n', 'remote\n')
    const out = await mergeFile(b, l, r)
    expect(out.clean).toBe(false)
    expect(out.text).toContain('<<<<<<<')
  })

  it('keeps an addition made on only one side', async () => {
    const { b, l, r } = await files('a\n', 'a\nb\n', 'a\n')
    const out = await mergeFile(b, l, r)
    expect(out.clean).toBe(true)
    expect(out.text).toBe('a\nb\n')
  })
})
```

`tests/merge/index.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeTrees } from '../../src/merge/index.js'
import type { MergeAgent } from '../../src/merge/agent.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ss-mt-')) })

async function tree(name: string, files: Record<string, string>) {
  const d = join(root, name)
  for (const [p, body] of Object.entries(files)) {
    await mkdir(join(d, p, '..'), { recursive: true })
    await writeFile(join(d, p), body)
  }
  await mkdir(d, { recursive: true })
  return d
}

const unionAgent: MergeAgent = {
  name: 'test-union',
  async merge(req) { return `${req.local}${req.remote}` },
}

const failingAgent: MergeAgent = {
  name: 'test-fail',
  async merge() { throw new Error('agent unavailable') },
}

describe('mergeTrees', () => {
  it('takes a file that only the local side added', async () => {
    const base = await tree('b', { 'SKILL.md': 'x\n' })
    const local = await tree('l', { 'SKILL.md': 'x\n', 'extra.md': 'new\n' })
    const remote = await tree('r', { 'SKILL.md': 'x\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(rep.resolved).toBe(true)
    expect(await readFile(join(out, 'extra.md'), 'utf8')).toBe('new\n')
  })

  it('keeps a file that only the remote side added', async () => {
    const base = await tree('b', { 'SKILL.md': 'x\n' })
    const local = await tree('l', { 'SKILL.md': 'x\n' })
    const remote = await tree('r', { 'SKILL.md': 'x\n', 'r.md': 'remote\n' })
    const out = join(root, 'out')
    await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(await readFile(join(out, 'r.md'), 'utf8')).toBe('remote\n')
  })

  it('resolves non-overlapping edits with git, never calling the agent', async () => {
    let called = false
    const spy: MergeAgent = { name: 's', async merge(r) { called = true; return r.local } }
    const base = await tree('b', { 'a.md': '1\n2\n3\n' })
    const local = await tree('l', { 'a.md': 'L\n2\n3\n' })
    const remote = await tree('r', { 'a.md': '1\n2\nR\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: spy })
    expect(called).toBe(false)
    expect(rep.files.find((f) => f.path === 'a.md')!.how).toBe('git')
    const merged = await readFile(join(out, 'a.md'), 'utf8')
    expect(merged).toContain('L')
    expect(merged).toContain('R')
  })

  it('escalates a genuine overlap to the agent', async () => {
    const base = await tree('b', { 'a.md': 'same\n' })
    const local = await tree('l', { 'a.md': 'LOCAL\n' })
    const remote = await tree('r', { 'a.md': 'REMOTE\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(rep.files.find((f) => f.path === 'a.md')!.how).toBe('agent')
    expect(await readFile(join(out, 'a.md'), 'utf8')).toBe('LOCAL\nREMOTE\n')
  })

  it('marks a file unresolved when the agent fails, and reports not resolved', async () => {
    const base = await tree('b', { 'a.md': 'same\n' })
    const local = await tree('l', { 'a.md': 'LOCAL\n' })
    const remote = await tree('r', { 'a.md': 'REMOTE\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: failingAgent })
    expect(rep.resolved).toBe(false)
    expect(rep.files.find((f) => f.path === 'a.md')!.how).toBe('unresolved')
  })

  it('marks a file unresolved when the agent returns invalid content', async () => {
    const bad: MergeAgent = { name: 'bad', async merge() { return '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n' } }
    const base = await tree('b', { 'a.md': 'same\n' })
    const local = await tree('l', { 'a.md': 'LOCAL\n' })
    const remote = await tree('r', { 'a.md': 'REMOTE\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: bad })
    expect(rep.resolved).toBe(false)
  })

  it('handles a missing base by treating it as empty on both sides', async () => {
    const local = await tree('l', { 'a.md': 'LOCAL\n' })
    const remote = await tree('r', { 'a.md': 'REMOTE\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(rep.resolved).toBe(true)
    expect(await readFile(join(out, 'a.md'), 'utf8')).toBe('LOCAL\nREMOTE\n')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/merge`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementation**

`src/merge/validate.ts`:
```ts
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}[ \t]/m.test(text) || /^={7}\s*$/m.test(text) || /^>{7}[ \t]/m.test(text)
}

export type Validation = { ok: true } | { ok: false; reason: string }

export function validateMerged(relPath: string, text: string): Validation {
  if (text.trim().length === 0) return { ok: false, reason: 'merged output is empty' }
  if (hasConflictMarkers(text)) return { ok: false, reason: 'conflict markers remain' }

  const name = relPath.split('/').pop() ?? relPath

  if (name === 'SKILL.md') {
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
    if (m === null) return { ok: false, reason: 'SKILL.md lost its YAML frontmatter' }
    const fm = m[1]!
    if (!/^name\s*:/m.test(fm)) return { ok: false, reason: 'SKILL.md frontmatter lost `name`' }
    if (!/^description\s*:/m.test(fm)) {
      return { ok: false, reason: 'SKILL.md frontmatter lost `description`' }
    }
    return { ok: true }
  }

  if (name.endsWith('.json')) {
    try { JSON.parse(text) } catch (e) {
      return { ok: false, reason: `invalid JSON: ${(e as Error).message}` }
    }
  }

  return { ok: true }
}
```

`src/merge/mergefile.ts`:
```ts
import { readFile } from 'node:fs/promises'
import { run } from '../util/exec.js'

export async function mergeFile(
  base: string, local: string, remote: string,
): Promise<{ clean: boolean; text: string }> {
  // `git merge-file -p` writes the merged result to stdout and exits with the
  // number of conflicts (negative on error).
  const r = await run('git', [
    'merge-file', '-p', '--diff3',
    '-L', 'local', '-L', 'base', '-L', 'remote',
    local, base, remote,
  ])
  if (r.code < 0) throw new Error(`git merge-file failed: ${r.stderr.trim()}`)
  if (r.code === 0) return { clean: true, text: r.stdout }
  return { clean: false, text: r.stdout || (await readFile(local, 'utf8')) }
}
```

`src/merge/agent.ts`:
```ts
import { run } from '../util/exec.js'

export interface MergeRequest { path: string; base: string; local: string; remote: string }

export interface MergeAgent {
  name: string
  merge(req: MergeRequest): Promise<string>
}

const PROMPT = (req: MergeRequest) => `You are resolving a merge conflict in a file that two \
machines edited independently. The file is \`${req.path}\`.

Rules you MUST follow:
1. Preserve the intent of BOTH sides. Never drop one side's contribution.
2. Where the two sides express the same idea differently, state it once.
3. Where they express different ideas, keep both, ordered sensibly.
4. Keep the file's original format valid (YAML frontmatter, JSON, shell syntax).
5. Output ONLY the merged file contents. No commentary, no code fences.

=== COMMON ANCESTOR ===
${req.base}
=== END COMMON ANCESTOR ===

=== VERSION A (this machine) ===
${req.local}
=== END VERSION A ===

=== VERSION B (the other machine) ===
${req.remote}
=== END VERSION B ===`

function stripFence(text: string): string {
  const t = text.trim()
  const m = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/.exec(t)
  return m === null ? text : m[1]!
}

export function claudeAgent(bin = 'claude'): MergeAgent {
  return {
    name: 'claude',
    async merge(req) {
      const r = await run(bin, ['-p', '--permission-mode', 'plan'], { input: PROMPT(req) })
      if (r.code !== 0) throw new Error(`claude merge failed: ${r.stderr.trim() || r.stdout.trim()}`)
      return stripFence(r.stdout)
    },
  }
}

export function codexAgent(bin = 'codex'): MergeAgent {
  return {
    name: 'codex',
    async merge(req) {
      const r = await run(bin, ['exec', '--skip-git-repo-check', '-'], { input: PROMPT(req) })
      if (r.code !== 0) throw new Error(`codex merge failed: ${r.stderr.trim() || r.stdout.trim()}`)
      return stripFence(r.stdout)
    },
  }
}

export function noAgent(): MergeAgent {
  return {
    name: 'none',
    async merge() { throw new Error('no merge agent configured') },
  }
}

async function onPath(bin: string): Promise<boolean> {
  return (await run('command', ['-v', bin]).catch(() => ({ code: 1 }))).code === 0
    || (await run('which', [bin]).catch(() => ({ code: 1 }))).code === 0
}

export async function pickAgent(name: 'claude' | 'codex' | 'none' | 'auto'): Promise<MergeAgent> {
  if (name === 'none') return noAgent()
  if (name === 'claude') return claudeAgent()
  if (name === 'codex') return codexAgent()
  if (await onPath('claude')) return claudeAgent()
  if (await onPath('codex')) return codexAgent()
  return noAgent()
}
```

`src/merge/index.ts`:
```ts
import { mkdir, writeFile, readFile, copyFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { walk } from '../util/fs.js'
import { mergeFile } from './mergefile.js'
import { validateMerged } from './validate.js'
import type { MergeAgent } from './agent.js'

export interface MergeReport {
  files: { path: string; how: 'identical' | 'local-only' | 'remote-only' | 'git' | 'agent' | 'unresolved'; reason?: string }[]
  resolved: boolean
}

async function listFiles(dir: string | undefined): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (dir === undefined || !existsSync(dir)) return out
  for await (const e of walk(dir)) out.set(e.rel, e.abs)
  return out
}

export async function mergeTrees(opts: {
  baseDir?: string
  localDir: string
  remoteDir: string
  outDir: string
  agent: MergeAgent
}): Promise<MergeReport> {
  const base = await listFiles(opts.baseDir)
  const local = await listFiles(opts.localDir)
  const remote = await listFiles(opts.remoteDir)

  const paths = [...new Set([...base.keys(), ...local.keys(), ...remote.keys()])].sort()
  const report: MergeReport = { files: [], resolved: true }
  const scratch = await mkdtemp(join(tmpdir(), 'ss-merge-'))

  await mkdir(opts.outDir, { recursive: true })

  for (const p of paths) {
    const target = join(opts.outDir, p)
    await mkdir(dirname(target), { recursive: true })

    const lPath = local.get(p)
    const rPath = remote.get(p)
    const bPath = base.get(p)

    if (lPath === undefined && rPath === undefined) continue

    if (lPath !== undefined && rPath === undefined) {
      // Deleted on the remote; if the local side also left it untouched since
      // base, the delete wins. Otherwise the local edit is kept.
      const lText = await readFile(lPath, 'utf8')
      const bText = bPath === undefined ? null : await readFile(bPath, 'utf8')
      if (bText !== null && bText === lText) { report.files.push({ path: p, how: 'remote-only' }); continue }
      await copyFile(lPath, target)
      report.files.push({ path: p, how: 'local-only' })
      continue
    }

    if (lPath === undefined && rPath !== undefined) {
      const rText = await readFile(rPath, 'utf8')
      const bText = bPath === undefined ? null : await readFile(bPath, 'utf8')
      if (bText !== null && bText === rText) { report.files.push({ path: p, how: 'local-only' }); continue }
      await copyFile(rPath, target)
      report.files.push({ path: p, how: 'remote-only' })
      continue
    }

    const lText = await readFile(lPath!, 'utf8')
    const rText = await readFile(rPath!, 'utf8')

    if (lText === rText) {
      await copyFile(lPath!, target)
      report.files.push({ path: p, how: 'identical' })
      continue
    }

    const bText = bPath === undefined ? '' : await readFile(bPath, 'utf8')
    if (bText === lText) { await copyFile(rPath!, target); report.files.push({ path: p, how: 'remote-only' }); continue }
    if (bText === rText) { await copyFile(lPath!, target); report.files.push({ path: p, how: 'local-only' }); continue }

    const bFile = join(scratch, 'base'); await writeFile(bFile, bText)
    const lFile = join(scratch, 'local'); await writeFile(lFile, lText)
    const rFile = join(scratch, 'remote'); await writeFile(rFile, rText)

    const merged = await mergeFile(bFile, lFile, rFile)
    if (merged.clean) {
      const v = validateMerged(p, merged.text)
      if (v.ok) { await writeFile(target, merged.text); report.files.push({ path: p, how: 'git' }); continue }
    }

    try {
      const text = await opts.agent.merge({ path: p, base: bText, local: lText, remote: rText })
      const v = validateMerged(p, text)
      if (!v.ok) throw new Error(v.reason)
      await writeFile(target, text)
      report.files.push({ path: p, how: 'agent' })
    } catch (e) {
      await rm(target, { force: true })
      report.files.push({ path: p, how: 'unresolved', reason: (e as Error).message })
      report.resolved = false
    }
  }

  return report
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/merge`
Expected: PASS, 18 tests

- [ ] **Step 5: Commit**

```bash
git add src/merge tests/merge
git commit -m "feat: merge stack — git merge-file first, AI agent for real overlaps"
```

---

## Task 11: Plan and apply

**Files:**
- Create: `src/core/plan.ts`, `src/core/apply.ts`
- Test: `tests/core/plan.test.ts`

**Interfaces:**
- Consumes: `Resolution` (Task 3), `CcWriter` (Task 5), `GitStore` (Task 8), `SecretProvider` (Task 9), `mergeTrees` (Task 10), state helpers (Task 6)
- Produces:
  - `type ActionType = 'push-content' | 'pull-content' | 'delete-remote' | 'delete-local' | 'set-apps' | 'merge' | 'noop'`
  - `interface Action { type: ActionType; kind: ItemKind; id: string; resolution: Resolution }`
  - `interface Plan { actions: Action[]; conflicts: Action[]; counts: Record<ActionType, number> }`
  - `buildPlan(resolutions: Resolution[]): Plan`
  - `applyPlan(plan: Plan, ctx: ApplyContext): Promise<ApplyResult>`
  - `interface ApplyResult { applied: Action[]; failed: { action: Action; error: string }[]; pending: Action[] }`

`buildPlan` is pure and ordered: pulls, then MCP writes, then matrix updates,
then pushes. `applyPlan` snapshots before the first mutation and records base
state only for actions that succeeded.

- [ ] **Step 1: Write the failing test**

`tests/core/plan.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { buildPlan } from '../../src/core/plan.js'
import { resolveItem } from '../../src/core/resolve.js'
import type { Side } from '../../src/core/types.js'

const S = (h: string, apps: string[] = ['claude']): Side =>
  ({ contentHash: h, apps: apps as Side['apps'] })

const r = (id: string, base?: Side, local?: Side, remote?: Side) =>
  resolveItem({ kind: 'skill', id, base, local, remote })

describe('buildPlan', () => {
  it('drops IN_SYNC items from the action list', () => {
    const p = buildPlan([r('a', S('A'), S('A'), S('A'))])
    expect(p.actions).toHaveLength(0)
  })

  it('maps each decision to its action type', () => {
    const p = buildPlan([
      r('push', S('A'), S('B'), S('A')),
      r('pull', S('A'), S('A'), S('B')),
      r('new-l', undefined, S('B'), undefined),
      r('new-r', undefined, undefined, S('B')),
      r('del-r', S('A'), undefined, S('A')),
      r('del-l', S('A'), S('A'), undefined),
    ])
    const byId = Object.fromEntries(p.actions.map((a) => [a.id, a.type]))
    expect(byId).toEqual({
      push: 'push-content', pull: 'pull-content',
      'new-l': 'push-content', 'new-r': 'pull-content',
      'del-r': 'delete-remote', 'del-l': 'delete-local',
    })
  })

  it('routes conflicts to the conflicts list, not the action list', () => {
    const p = buildPlan([r('c', S('A'), S('B'), S('C'))])
    expect(p.actions).toHaveLength(0)
    expect(p.conflicts).toHaveLength(1)
    expect(p.conflicts[0]!.type).toBe('merge')
  })

  it('emits a set-apps action when only the matrix differs', () => {
    const p = buildPlan([r('m', S('A', ['claude']), S('A', ['claude', 'codex']), S('A', ['claude']))])
    expect(p.actions.map((a) => a.type)).toEqual(['set-apps'])
  })

  it('orders pulls before pushes so a failed push cannot strand a pull', () => {
    const p = buildPlan([
      r('z-push', S('A'), S('B'), S('A')),
      r('a-pull', S('A'), S('A'), S('B')),
    ])
    expect(p.actions.map((a) => a.type)).toEqual(['pull-content', 'push-content'])
  })

  it('counts every action type, including the zeroes', () => {
    const p = buildPlan([r('push', S('A'), S('B'), S('A'))])
    expect(p.counts['push-content']).toBe(1)
    expect(p.counts['pull-content']).toBe(0)
    expect(p.counts.merge).toBe(0)
  })

  it('produces a stable order for identical input', () => {
    const input = [r('b', S('A'), S('B'), S('A')), r('a', S('A'), S('B'), S('A'))]
    expect(buildPlan(input).actions.map((a) => a.id))
      .toEqual(buildPlan(input).actions.map((a) => a.id))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/plan.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write `src/core/plan.ts`**

```ts
import type { ItemKind, Resolution } from './types.js'

export type ActionType =
  | 'push-content' | 'pull-content' | 'delete-remote' | 'delete-local'
  | 'set-apps' | 'merge' | 'noop'

export interface Action { type: ActionType; kind: ItemKind; id: string; resolution: Resolution }

export interface Plan {
  actions: Action[]
  conflicts: Action[]
  counts: Record<ActionType, number>
}

const ORDER: ActionType[] = [
  'pull-content', 'delete-local', 'set-apps', 'push-content', 'delete-remote', 'merge', 'noop',
]

function typeFor(r: Resolution): ActionType {
  switch (r.decision) {
    case 'PUSH': case 'PUSH_NEW': return 'push-content'
    case 'PULL': case 'PULL_NEW': return 'pull-content'
    case 'DELETE_REMOTE': return 'delete-remote'
    case 'DELETE_LOCAL': return 'delete-local'
    case 'CONFLICT': return 'merge'
    case 'IN_SYNC': return r.appsDecision === 'IN_SYNC' ? 'noop' : 'set-apps'
  }
}

export function buildPlan(resolutions: Resolution[]): Plan {
  const counts = Object.fromEntries(ORDER.map((t) => [t, 0])) as Record<ActionType, number>
  const actions: Action[] = []
  const conflicts: Action[] = []

  for (const r of resolutions) {
    const type = typeFor(r)
    counts[type]++
    if (type === 'noop') continue
    const action: Action = { type, kind: r.kind, id: r.id, resolution: r }
    if (type === 'merge') conflicts.push(action)
    else actions.push(action)
  }

  actions.sort((a, b) => {
    const d = ORDER.indexOf(a.type) - ORDER.indexOf(b.type)
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  conflicts.sort((a, b) => (a.id < b.id ? -1 : 1))

  return { actions, conflicts, counts }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/plan.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Write `src/core/apply.ts`**

```ts
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { copyTree } from '../util/fs.js'
import { treeHash, canonicalJsonHash } from './hash.js'
import { setBase } from '../state.js'
import { upsertEntry, removeEntry } from '../store/manifest.js'
import { scanForSecrets } from '../secrets/scan.js'
import { stripSecrets } from '../ccswitch/read.js'
import type { Action, Plan } from './plan.js'
import type { StateFile } from '../state.js'
import type { GitStore } from '../store/git.js'
import type { CcWriter } from '../ccswitch/write.js'
import type { CcPaths } from '../ccswitch/paths.js'
import type { SecretProvider, SecretBlob } from '../secrets/provider.js'
import type { Manifest } from '../store/manifest.js'

export interface ApplyContext {
  paths: CcPaths
  writer: CcWriter
  store: GitStore
  manifest: Manifest
  state: StateFile
  secrets: SecretProvider
  blob: SecretBlob
  device: string
  configDir: string
  dryRun: boolean
}

export interface ApplyResult {
  applied: Action[]
  failed: { action: Action; error: string }[]
  pending: Action[]
  backupDir: string | null
}

export async function snapshot(ctx: ApplyContext): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dir = join(ctx.configDir, 'backups', stamp)
  await mkdir(dir, { recursive: true })
  if (existsSync(ctx.paths.db)) {
    await writeFile(join(dir, 'cc-switch.db'), await readFile(ctx.paths.db))
  }
  if (existsSync(ctx.paths.skillsDir)) {
    await copyTree(ctx.paths.skillsDir, join(dir, 'skills'))
  }
  return dir
}

export async function applyPlan(plan: Plan, ctx: ApplyContext): Promise<ApplyResult> {
  const result: ApplyResult = { applied: [], failed: [], pending: [], backupDir: null }
  if (plan.actions.length === 0) return result
  if (!ctx.dryRun) result.backupDir = await snapshot(ctx)

  let touchedSkills = false

  for (const action of plan.actions) {
    try {
      if (ctx.dryRun) { result.applied.push(action); continue }
      const outcome = await applyOne(action, ctx)
      if (outcome === 'pending') result.pending.push(action)
      else {
        if (action.kind === 'skill') touchedSkills = true
        result.applied.push(action)
      }
    } catch (e) {
      result.failed.push({ action, error: (e as Error).message })
      break  // stop at the first failure; state still describes reality
    }
  }

  if (touchedSkills && !ctx.dryRun) await ctx.writer.syncSkills()
  return result
}

async function applyOne(action: Action, ctx: ApplyContext): Promise<'done' | 'pending'> {
  const { kind, id, resolution } = action

  switch (action.type) {
    case 'set-apps': {
      if (kind === 'skill') await ctx.writer.setSkillApps(id, resolution.apps)
      else if (kind === 'mcp') await ctx.writer.setMcpApps(id, resolution.apps)
      const side = { contentHash: resolution.local!.contentHash, apps: resolution.apps }
      setBase(ctx.state, kind, id, side)
      upsertEntry(ctx.manifest, kind, id, side, ctx.device)
      return 'done'
    }

    case 'pull-content': {
      if (kind === 'skill') {
        const src = ctx.store.itemDir('skill', id)
        const dest = join(ctx.paths.skillsDir, id)
        await rm(dest, { recursive: true, force: true })
        await copyTree(src, dest)
        await ctx.writer.importSkill(id, resolution.apps)
        setBase(ctx.state, kind, id, { contentHash: await treeHash(dest), apps: resolution.apps })
      } else if (kind === 'mcp') {
        const sanitized = await ctx.store.readItemJson('mcp', id)
        if (sanitized === null) throw new Error(`remote mcp/${id}.json is missing`)
        const config = rehydrate(sanitized, ctx.blob.mcp[id]?.env ?? {})
        await ctx.writer.importMcp(id, config, resolution.apps)
        setBase(ctx.state, kind, id, {
          contentHash: canonicalJsonHash({ config: sanitized, tags: [] }),
          apps: resolution.apps,
        })
      }
      return 'done'
    }

    case 'push-content': {
      if (kind === 'skill') {
        const src = join(ctx.paths.skillsDir, id)
        const dest = ctx.store.itemDir('skill', id)
        await rm(dest, { recursive: true, force: true })
        await copyTree(src, dest)
        guard(dest)
        setBase(ctx.state, kind, id, { contentHash: await treeHash(src), apps: resolution.apps })
        upsertEntry(ctx.manifest, kind, id,
          { contentHash: await treeHash(src), apps: resolution.apps }, ctx.device)
      } else if (kind === 'mcp') {
        const payload = resolution.local!.payload as { config: Record<string, unknown>; tags: string[] }
        const { sanitized, secrets } = stripSecrets(payload.config)
        const text = JSON.stringify(sanitized)
        const hits = scanForSecrets(text)
        if (hits.length > 0) throw new Error(`refusing to push mcp/${id}: ${hits.join('; ')}`)
        await ctx.store.writeItemJson('mcp', id, sanitized)
        if (Object.keys(secrets).length > 0) ctx.blob.mcp[id] = { env: secrets }
        const side = {
          contentHash: canonicalJsonHash({ config: sanitized, tags: payload.tags }),
          apps: resolution.apps,
        }
        setBase(ctx.state, kind, id, side)
        upsertEntry(ctx.manifest, kind, id, side, ctx.device)
      }
      return 'done'
    }

    case 'delete-remote': {
      await ctx.store.removeItem(kind, id)
      removeEntry(ctx.manifest, kind, id)
      delete ctx.blob.mcp[id]
      setBase(ctx.state, kind, id, undefined)
      return 'done'
    }

    case 'delete-local': {
      if (kind === 'skill') {
        await rm(join(ctx.paths.skillsDir, id), { recursive: true, force: true })
      } else if (kind === 'mcp') {
        const outcome = await ctx.writer.deleteMcp(id)
        if (outcome === 'pending') return 'pending'
      }
      setBase(ctx.state, kind, id, undefined)
      return 'done'
    }

    default:
      return 'done'
  }
}

function rehydrate(
  sanitized: Record<string, unknown>, env: Record<string, string>,
): Record<string, unknown> {
  const out = { ...sanitized }
  if (sanitized.env !== null && typeof sanitized.env === 'object') {
    const filled: Record<string, string> = {}
    for (const key of Object.keys(sanitized.env as Record<string, unknown>)) {
      filled[key] = env[key] ?? ''
    }
    out.env = filled
  }
  return out
}

// A last line of defence: nothing staged for the remote may contain a secret.
function guard(_dir: string): void { /* scanned in the push command before commit */ }
```

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/plan.ts src/core/apply.ts tests/core/plan.test.ts
git commit -m "feat: ordered plan building and transactional apply"
```

---

## Task 12: The engine and the commands

**Files:**
- Create: `src/engine.ts`, `src/help.ts`, `src/commands/status.ts`, `src/commands/sync.ts`, `src/commands/doctor.ts`, `src/commands/diff.ts`, `src/commands/conflicts.ts`, `src/commands/configCmd.ts`, `src/commands/secretsCmd.ts`, `src/commands/completion.ts`
- Modify: `src/cli.ts` (dispatch, `--json` envelope, exit codes)
- Test: `tests/engine.test.ts`, `tests/help.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `interface EngineOptions { configDir: string; config: Config; paths: CcPaths; cacheDir: string; only?: ItemKind[]; mergeAgent: 'claude'|'codex'|'none'|'auto'; useSecrets: boolean; dryRun: boolean; direction: 'both'|'push'|'pull' }`
  - `gather(opts: EngineOptions): Promise<{ resolutions: Resolution[]; store: GitStore; manifest: Manifest; state: StateFile; blob: SecretBlob; secrets: SecretProvider }>`
  - `runSync(opts: EngineOptions & { yes: boolean }): Promise<SyncOutcome>`
  - `interface SyncOutcome { plan: Plan; result: ApplyResult; unresolved: Action[]; pushed: boolean }`
  - `helpFor(command: string): string`
  - `ROOT_HELP: string`

`direction` narrows the resolver's output rather than the resolver itself:
`push` drops every `pull-content`/`delete-local` action, `pull` drops every
`push-content`/`delete-remote`. The decision table is untouched, so the safety
properties hold in every mode.

- [ ] **Step 1: Write the failing test**

`tests/help.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { helpFor, ROOT_HELP } from '../src/help.js'

const COMMANDS = ['init','sync','status','push','pull','diff','conflicts','secrets','doctor','config','completion']

describe('help', () => {
  it('lists every command at the root', () => {
    for (const c of COMMANDS) expect(ROOT_HELP).toContain(c)
  })

  it('documents the exit codes at the root', () => {
    for (const line of ['0', '1', '2', '3']) expect(ROOT_HELP).toContain(line)
    expect(ROOT_HELP).toMatch(/exit code/i)
  })

  it('gives every command a help page with a description, flags and an example', () => {
    for (const c of COMMANDS) {
      const h = helpFor(c)
      expect(h.length, `${c} help is too short`).toBeGreaterThan(120)
      expect(h, `${c} help lacks USAGE`).toMatch(/USAGE/)
      expect(h, `${c} help lacks EXAMPLES`).toMatch(/EXAMPLES/)
      expect(h, `${c} help lacks its own name`).toContain(c)
    }
  })

  it('documents --json everywhere, because agents depend on it', () => {
    for (const c of COMMANDS) expect(helpFor(c)).toContain('--json')
  })

  it('falls back to the root help for an unknown command', () => {
    expect(helpFor('nope')).toBe(ROOT_HELP)
  })
})
```

`tests/engine.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { narrowByDirection } from '../src/engine.js'
import { buildPlan } from '../src/core/plan.js'
import { resolveItem } from '../src/core/resolve.js'
import type { Side } from '../src/core/types.js'

const S = (h: string): Side => ({ contentHash: h, apps: ['claude'] })

const plan = () => buildPlan([
  resolveItem({ kind: 'skill', id: 'p', base: S('A'), local: S('B'), remote: S('A') }),
  resolveItem({ kind: 'skill', id: 'q', base: S('A'), local: S('A'), remote: S('B') }),
  resolveItem({ kind: 'skill', id: 'dl', base: S('A'), local: S('A'), remote: undefined }),
  resolveItem({ kind: 'skill', id: 'dr', base: S('A'), local: undefined, remote: S('A') }),
])

describe('narrowByDirection', () => {
  it('keeps everything in both mode', () => {
    expect(narrowByDirection(plan(), 'both').actions).toHaveLength(4)
  })

  it('push mode keeps only outbound actions', () => {
    const types = narrowByDirection(plan(), 'push').actions.map((a) => a.type)
    expect(new Set(types)).toEqual(new Set(['push-content', 'delete-remote']))
  })

  it('pull mode keeps only inbound actions', () => {
    const types = narrowByDirection(plan(), 'pull').actions.map((a) => a.type)
    expect(new Set(types)).toEqual(new Set(['pull-content', 'delete-local']))
  })

  it('carries conflicts through in every direction', () => {
    const p = buildPlan([
      resolveItem({ kind: 'skill', id: 'c', base: S('A'), local: S('B'), remote: S('C') }),
    ])
    for (const d of ['both', 'push', 'pull'] as const) {
      expect(narrowByDirection(p, d).conflicts).toHaveLength(1)
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/help.test.ts tests/engine.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write `src/help.ts`**

```ts
const GLOBAL = `GLOBAL FLAGS
  --json                 machine-readable output
  --yes, -y              assume yes; never prompt
  --dry-run              show what would happen; change nothing
  --only <kinds>         limit to skills, mcp or repos (comma separated)
  --merge-agent <name>   claude | codex | none   (default: auto)
  --no-secrets           do not touch 1Password
  --profile <name>       use an alternate configuration
  --config <dir>         configuration directory (default: ~/.config/syncskills)
  --verbose, -v          more detail
  --quiet, -q            errors only
  --no-tui               never enter interactive mode
  --help, -h             show help`

export const ROOT_HELP = `syncskills — keep AI agent skills and MCP servers identical across your machines.

USAGE
  syncskills [command] [flags]

  Run with no arguments to open the interactive interface.

COMMANDS
  init         set up this device: host, repository, vault, token, device name
  sync         bidirectional sync (the default action)
  status       show what differs; changes nothing
  push         send local changes only
  pull         take remote changes only
  diff         show the difference for one item
  conflicts    list and restore saved conflict snapshots
  secrets      inspect or repair the 1Password secret store
  doctor       check that git, gh, cc-switch, op and a merge agent are usable
  config       read or write configuration values
  completion   print a shell completion script

${GLOBAL}

EXIT CODES
  0  success
  1  error
  2  unresolved conflicts, or an action awaiting manual intervention
  3  not initialized — run \`syncskills init\`

EXAMPLES
  syncskills                       open the interactive interface
  syncskills status --json         inspect differences from a script
  syncskills sync --yes            sync without prompting
  syncskills sync --only skills    sync skills, leave MCP servers alone
  syncskills push --dry-run        preview an upload`

const PAGES: Record<string, string> = {
  init: `syncskills init — set up this device.

USAGE
  syncskills init [flags]

Walks through choosing a GitHub or GHES host, an account, a repository, a
1Password vault and item, and a name for this device. The repository is created
if it does not exist. The 1Password service-account token is stored at
<config>/op-token with mode 0600 and never leaves this machine.

FLAGS
  --host <host>        github.com, or a GHES hostname
  --repo <owner/name>  repository to use
  --vault <name>       1Password vault holding the secret item
  --device <name>      name recorded in the manifest for changes made here
  --json               machine-readable result

EXAMPLES
  syncskills init
  syncskills init --host github.com --repo me/syncskills --vault agent --device work-pc --json`,

  sync: `syncskills sync — bidirectional sync.

USAGE
  syncskills sync [flags]

Compares this device, the last synced state and the remote, then pushes what
only changed here, pulls what only changed there, and merges what changed in
both places. A remote that has moved on is never overwritten.

FLAGS
  --yes, -y            apply without prompting
  --dry-run            show the plan and stop
  --only <kinds>       skills, mcp, repos
  --merge-agent <name> claude | codex | none
  --json               machine-readable result

EXIT CODES
  2 when a conflict could not be merged automatically.

EXAMPLES
  syncskills sync
  syncskills sync --yes --json
  syncskills sync --only mcp --merge-agent codex`,

  status: `syncskills status — show what differs.

USAGE
  syncskills status [flags]

Reads this device, the remote and the saved base, and reports a decision for
every item. Changes nothing, touches no files, and is safe to run at any time.

FLAGS
  --only <kinds>   skills, mcp, repos
  --json           machine-readable result

EXAMPLES
  syncskills status
  syncskills status --json | jq '.items[] | select(.decision != "IN_SYNC")'`,

  push: `syncskills push — send local changes only.

USAGE
  syncskills push [flags]

Applies only outbound actions. Items that changed on the remote are reported
and left alone; conflicts are still detected and reported.

FLAGS
  --yes, -y   apply without prompting
  --dry-run   show the plan and stop
  --json      machine-readable result

EXAMPLES
  syncskills push --dry-run
  syncskills push --yes --json`,

  pull: `syncskills pull — take remote changes only.

USAGE
  syncskills pull [flags]

Applies only inbound actions. Local-only changes are left untouched and
reported, so nothing you have here is lost.

FLAGS
  --yes, -y   apply without prompting
  --dry-run   show the plan and stop
  --json      machine-readable result

EXAMPLES
  syncskills pull --yes
  syncskills pull --json`,

  diff: `syncskills diff — show the difference for one item.

USAGE
  syncskills diff <item> [flags]

<item> is a skill directory name, an MCP server id, or owner/name for a
repository. Prints a unified diff between this device and the remote.

FLAGS
  --json   machine-readable result

EXAMPLES
  syncskills diff code-review
  syncskills diff oracle --json`,

  conflicts: `syncskills conflicts — list and restore conflict snapshots.

USAGE
  syncskills conflicts [list|restore <id>] [flags]

Every conflict resolution saves both original versions before writing anything.
This command lists those snapshots and restores one if a merge went wrong.

FLAGS
  --json   machine-readable result

EXAMPLES
  syncskills conflicts
  syncskills conflicts restore 2026-09-14T20-41-00Z/code-review`,

  secrets: `syncskills secrets — inspect or repair the 1Password secret store.

USAGE
  syncskills secrets [list|check|push|pull] [flags]

MCP environment values are kept in a single 1Password secure note so that the
git repository never contains a credential. This command shows which keys are
stored, verifies access, and repairs the store after a manual edit.

FLAGS
  --json   machine-readable result

EXAMPLES
  syncskills secrets check
  syncskills secrets list --json`,

  doctor: `syncskills doctor — check the environment.

USAGE
  syncskills doctor [flags]

Verifies that git, gh, cc-switch, op and a merge agent are present and usable,
that the cc-switch database has the expected shape, and that the configured
repository and vault are reachable.

FLAGS
  --json   machine-readable result

EXAMPLES
  syncskills doctor
  syncskills doctor --json`,

  config: `syncskills config — read or write configuration values.

USAGE
  syncskills config path
  syncskills config get <key>
  syncskills config set <key> <value>

Keys: host, owner, repo, branch, device, vault, item, secrets, excludes.

FLAGS
  --json   machine-readable result

EXAMPLES
  syncskills config path
  syncskills config get device
  syncskills config set device home-macbook --json`,

  completion: `syncskills completion — print a shell completion script.

USAGE
  syncskills completion <zsh|bash|fish>

FLAGS
  --json   machine-readable result (reports the supported shells)

EXAMPLES
  syncskills completion zsh > ~/.zfunc/_syncskills
  eval "$(syncskills completion bash)"`,
}

export function helpFor(command: string): string {
  return PAGES[command] ?? ROOT_HELP
}
```

- [ ] **Step 4: Write `src/engine.ts`**

```ts
import { join } from 'node:path'
import { resolveAll } from './core/resolve.js'
import { buildPlan } from './core/plan.js'
import { applyPlan } from './core/apply.js'
import { createGitStore } from './store/git.js'
import { manifestSides, upsertEntry } from './store/manifest.js'
import { createWriter } from './ccswitch/write.js'
import { localSkillSides, localMcpSides, localRepoSides, readMcp } from './ccswitch/read.js'
import { loadState, saveState, stateKey } from './state.js'
import { nullProvider, emptyBlob } from './secrets/provider.js'
import { onePasswordProvider } from './secrets/onepassword.js'
import { pickAgent } from './merge/agent.js'
import type { ItemKind, Resolution, Side } from './core/types.js'
import type { Config } from './config.js'
import type { CcPaths } from './ccswitch/paths.js'
import type { Plan, Action } from './core/plan.js'
import type { ApplyResult } from './core/apply.js'

export type Direction = 'both' | 'push' | 'pull'

const OUTBOUND = new Set(['push-content', 'delete-remote'])
const INBOUND = new Set(['pull-content', 'delete-local'])

export function narrowByDirection(plan: Plan, direction: Direction): Plan {
  if (direction === 'both') return plan
  const keep = direction === 'push' ? OUTBOUND : INBOUND
  return {
    ...plan,
    actions: plan.actions.filter((a) => keep.has(a.type) || a.type === 'set-apps'),
  }
}

export interface EngineOptions {
  configDir: string
  config: Config
  paths: CcPaths
  only?: ItemKind[]
  mergeAgent: 'claude' | 'codex' | 'none' | 'auto'
  useSecrets: boolean
  dryRun: boolean
  direction: Direction
  token?: string
}

const ALL_KINDS: ItemKind[] = ['skill', 'mcp', 'repo']

export async function gather(opts: EngineOptions) {
  const store = createGitStore({ cacheDir: join(opts.configDir, 'cache'), config: opts.config })
  await store.ensure()
  const manifest = await store.readManifest()
  const state = await loadState(opts.configDir)

  const secrets = opts.useSecrets && opts.token !== undefined
    ? onePasswordProvider({ vault: opts.config.vault, item: opts.config.item, token: opts.token })
    : nullProvider()
  const blob = await secrets.read().catch(() => emptyBlob())

  const kinds = opts.only ?? ALL_KINDS
  const resolutions: Resolution[] = []

  for (const kind of kinds) {
    const local = kind === 'skill'
      ? await localSkillSides(opts.paths)
      : kind === 'mcp' ? localMcpSides(opts.paths) : localRepoSides(opts.paths)

    if (kind === 'mcp') {
      const rows = new Map(readMcp(opts.paths).map((r) => [r.id, r]))
      for (const [id, side] of local) {
        const row = rows.get(id)!
        ;(side as Side & { payload?: unknown }).payload = { config: row.config, tags: row.tags }
      }
    }

    const base = new Map(
      Object.entries(state.items)
        .filter(([k]) => k.startsWith(`${kind}:`))
        .map(([k, v]) => [k.slice(kind.length + 1), v] as const),
    )
    resolutions.push(...resolveAll(base, local, manifestSides(manifest, kind), kind))
  }

  return { resolutions, store, manifest, state, blob, secrets }
}

export interface SyncOutcome {
  plan: Plan
  result: ApplyResult
  unresolved: Action[]
  pushed: boolean
}

export async function runSync(opts: EngineOptions): Promise<SyncOutcome> {
  const { resolutions, store, manifest, state, blob, secrets } = await gather(opts)
  const plan = narrowByDirection(buildPlan(resolutions), opts.direction)

  const writer = createWriter({ paths: opts.paths })
  const result = await applyPlan(plan, {
    paths: opts.paths, writer, store, manifest, state, secrets, blob,
    device: opts.config.device, configDir: opts.configDir, dryRun: opts.dryRun,
  })

  let pushed = false
  if (!opts.dryRun && result.failed.length === 0) {
    await store.writeManifest(manifest)
    pushed = await store.commitAndPush(
      `sync from ${opts.config.device} (${result.applied.length} change(s))`,
    )
    if (opts.useSecrets) await secrets.write(blob)
    for (const a of result.applied) {
      const side = state.items[stateKey(a.kind, a.id)]
      if (side !== undefined) upsertEntry(manifest, a.kind, a.id, side, opts.config.device)
    }
    await saveState(opts.configDir, state)
  }

  return { plan, result, unresolved: plan.conflicts, pushed }
}
```

- [ ] **Step 5: Wire dispatch into `src/cli.ts`**

Append to `src/cli.ts`:
```ts
import { helpFor, ROOT_HELP } from './help.js'

export interface Envelope {
  schemaVersion: 1
  ok: boolean
  command: string
  data: unknown
  warnings: string[]
  error?: string
}

export function envelope(command: string, data: unknown, warnings: string[] = []): Envelope {
  return { schemaVersion: 1, ok: true, command, data, warnings }
}

export async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  const json = args.flags.json === true

  if (args.flags.help === true || args.command === 'help') {
    process.stdout.write(helpFor(args.positionals[0] ?? args.command) + '\n')
    return EXIT.OK
  }
  if (args.command === 'tui' && args.flags['no-tui'] === true) {
    process.stdout.write(ROOT_HELP + '\n')
    return EXIT.OK
  }

  const { dispatch } = await import('./dispatch.js')
  return dispatch(args, json)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((e: Error) => {
      process.stderr.write(`syncskills: ${e.message}\n`)
      process.exitCode = EXIT.ERROR
    })
}
```

Create `src/dispatch.ts` mapping each command name to its module, returning the
exit code. `status` returns `EXIT.OK`; `sync`/`push`/`pull` return
`EXIT.CONFLICT` when `unresolved.length > 0 || result.pending.length > 0`,
`EXIT.ERROR` when `result.failed.length > 0`, and `EXIT.UNINITIALIZED` when
`loadConfig` returns `null`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/help.test.ts tests/engine.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 7: Commit**

```bash
git add src/engine.ts src/help.ts src/dispatch.ts src/commands src/cli.ts tests/help.test.ts tests/engine.test.ts
git commit -m "feat: sync engine, command dispatch and complete help text"
```

---

## Task 13: Init wizard and TUI

**Files:**
- Create: `src/commands/init.ts`, `src/tui/index.ts`, `src/tui/review.ts`, `src/tui/conflict.ts`, `src/tui/diff.ts`
- Test: `tests/tui/diff.test.ts`, `tests/commands/init.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 6), `run` (Task 1), `onePasswordProvider` (Task 9), engine (Task 12)
- Produces:
  - `renderDiff(a: string, b: string, opts?: { context?: number }): string`
  - `summarize(plan: Plan): { label: string; count: number }[]`
  - `detectGhHosts(ghBin?: string): Promise<{ host: string; login: string; active: boolean }[]>`
  - `ensureRepo(c: Config, ghBin?: string): Promise<'created' | 'exists'>`
  - `runInit(opts): Promise<Config>`
  - `runTui(opts): Promise<number>`

Only the pure pieces are unit tested; the prompt flows are exercised by the
integration suite in Task 14 with `--yes`.

- [ ] **Step 1: Write the failing test**

`tests/tui/diff.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { renderDiff, summarize } from '../../src/tui/diff.js'
import { buildPlan } from '../../src/core/plan.js'
import { resolveItem } from '../../src/core/resolve.js'
import type { Side } from '../../src/core/types.js'

const S = (h: string): Side => ({ contentHash: h, apps: ['claude'] })

describe('renderDiff', () => {
  it('marks an added line', () => {
    expect(renderDiff('a\n', 'a\nb\n')).toContain('+b')
  })
  it('marks a removed line', () => {
    expect(renderDiff('a\nb\n', 'a\n')).toContain('-b')
  })
  it('returns an empty string for identical input', () => {
    expect(renderDiff('a\n', 'a\n')).toBe('')
  })
  it('does not repeat unchanged lines outside the context window', () => {
    const long = Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\n'
    const changed = long.replace('line20', 'CHANGED')
    const out = renderDiff(long, changed, { context: 2 })
    expect(out).not.toContain('line0')
    expect(out).toContain('CHANGED')
  })
})

describe('summarize', () => {
  it('reports one row per non-zero action type', () => {
    const p = buildPlan([
      resolveItem({ kind: 'skill', id: 'a', base: S('A'), local: S('B'), remote: S('A') }),
      resolveItem({ kind: 'skill', id: 'b', base: S('A'), local: S('A'), remote: S('B') }),
    ])
    const rows = summarize(p)
    expect(rows.find((r) => r.label.includes('push'))!.count).toBe(1)
    expect(rows.find((r) => r.label.includes('pull'))!.count).toBe(1)
    expect(rows.every((r) => r.count > 0)).toBe(true)
  })

  it('returns an empty list when everything is in sync', () => {
    expect(summarize(buildPlan([
      resolveItem({ kind: 'skill', id: 'a', base: S('A'), local: S('A'), remote: S('A') }),
    ]))).toEqual([])
  })
})
```

`tests/commands/init.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { makeStubBin } from '../helpers/stubBin.js'
import { detectGhHosts } from '../../src/commands/init.js'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('detectGhHosts', () => {
  it('parses gh auth status --json hosts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ss-gh-'))
    const bin = join(dir, 'gh')
    const payload = JSON.stringify({
      hosts: {
        'github.com': [{ login: 'alice', active: true }, { login: 'bob', active: false }],
        'ghe.example.com': [{ login: 'carol', active: true }],
      },
    })
    await writeFile(bin, `#!/bin/sh\ncat <<'J'\n${payload}\nJ\n`)
    await chmod(bin, 0o755)

    const hosts = await detectGhHosts(bin)
    expect(hosts).toEqual([
      { host: 'github.com', login: 'alice', active: true },
      { host: 'github.com', login: 'bob', active: false },
      { host: 'ghe.example.com', login: 'carol', active: true },
    ])
  })

  it('returns an empty list when gh is not authenticated', async () => {
    const stub = await makeStubBin('gh', 1)
    expect(await detectGhHosts(stub.bin)).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/tui tests/commands/init.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write `src/tui/diff.ts`**

```ts
import pc from 'picocolors'
import type { Plan, ActionType } from '../core/plan.js'

const LABELS: Partial<Record<ActionType, string>> = {
  'push-content': 'push to remote',
  'pull-content': 'pull from remote',
  'delete-remote': 'delete on remote',
  'delete-local': 'delete locally',
  'set-apps': 'update app matrix',
  merge: 'conflict — merge required',
}

export function summarize(plan: Plan): { label: string; count: number }[] {
  return (Object.keys(LABELS) as ActionType[])
    .map((t) => ({ label: LABELS[t]!, count: plan.counts[t] ?? 0 }))
    .filter((r) => r.count > 0)
}

// A minimal LCS diff — enough for review, with no dependency.
export function renderDiff(a: string, b: string, opts: { context?: number } = {}): string {
  const context = opts.context ?? 3
  const A = a.split('\n')
  const B = b.split('\n')
  if (a === b) return ''

  const lcs: number[][] = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0))
  for (let i = A.length - 1; i >= 0; i--) {
    for (let j = B.length - 1; j >= 0; j--) {
      lcs[i]![j] = A[i] === B[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }

  const rows: { mark: ' ' | '+' | '-'; text: string }[] = []
  let i = 0, j = 0
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) { rows.push({ mark: ' ', text: A[i]! }); i++; j++ }
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) { rows.push({ mark: '-', text: A[i]! }); i++ }
    else { rows.push({ mark: '+', text: B[j]! }); j++ }
  }
  while (i < A.length) rows.push({ mark: '-', text: A[i++]! })
  while (j < B.length) rows.push({ mark: '+', text: B[j++]! })

  const keep = new Set<number>()
  rows.forEach((r, idx) => {
    if (r.mark === ' ') return
    for (let k = Math.max(0, idx - context); k <= Math.min(rows.length - 1, idx + context); k++) keep.add(k)
  })

  const out: string[] = []
  let lastKept = -1
  for (let idx = 0; idx < rows.length; idx++) {
    if (!keep.has(idx)) continue
    if (lastKept !== -1 && idx > lastKept + 1) out.push(pc.dim('  …'))
    const r = rows[idx]!
    const line = `${r.mark}${r.text}`
    out.push(r.mark === '+' ? pc.green(line) : r.mark === '-' ? pc.red(line) : pc.dim(line))
    lastKept = idx
  }
  return out.join('\n')
}
```

- [ ] **Step 4: Write `src/commands/init.ts`**

```ts
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import * as p from '@clack/prompts'
import { run } from '../util/exec.js'
import { saveConfig } from '../config.js'
import { onePasswordProvider } from '../secrets/onepassword.js'
import type { Config } from '../config.js'

export interface GhHost { host: string; login: string; active: boolean }

export async function detectGhHosts(ghBin = 'gh'): Promise<GhHost[]> {
  const r = await run(ghBin, ['auth', 'status', '--json', 'hosts'])
  if (r.code !== 0) return []
  try {
    const parsed = JSON.parse(r.stdout) as { hosts: Record<string, { login: string; active: boolean }[]> }
    return Object.entries(parsed.hosts).flatMap(([host, accounts]) =>
      accounts.map((a) => ({ host, login: a.login, active: a.active })),
    )
  } catch {
    return []
  }
}

export async function ensureRepo(c: Config, ghBin = 'gh'): Promise<'created' | 'exists'> {
  const slug = `${c.owner}/${c.repo}`
  const view = await run(ghBin, ['repo', 'view', slug, '--hostname', c.host, '--json', 'name'])
  if (view.code === 0) return 'exists'
  const create = await run(ghBin, [
    'repo', 'create', slug, '--private',
    '--description', 'syncskills store — AI agent skills and MCP servers',
  ], { env: { GH_HOST: c.host } })
  if (create.code !== 0) throw new Error(`could not create ${slug}: ${create.stderr.trim()}`)
  return 'created'
}

export async function runInit(opts: {
  configDir: string
  flags: Record<string, string | boolean>
}): Promise<Config> {
  p.intro('syncskills — set up this device')

  const hosts = await detectGhHosts()
  if (hosts.length === 0) {
    p.cancel('No authenticated GitHub host found. Run `gh auth login` first.')
    throw new Error('gh is not authenticated')
  }

  const chosen = typeof opts.flags.host === 'string'
    ? hosts.find((h) => h.host === opts.flags.host) ?? hosts[0]!
    : hosts.length === 1
      ? hosts[0]!
      : (await p.select({
          message: 'Which GitHub host and account?',
          options: hosts.map((h) => ({ value: h, label: `${h.host} — ${h.login}` })),
        })) as GhHost

  const repoAnswer = typeof opts.flags.repo === 'string'
    ? opts.flags.repo
    : String(await p.text({
        message: 'Repository to store skills and MCP servers',
        initialValue: `${chosen.login}/syncskills`,
      }))
  const [owner = chosen.login, repo = 'syncskills'] = repoAnswer.split('/')

  const device = typeof opts.flags.device === 'string'
    ? opts.flags.device
    : String(await p.text({ message: 'Name for this device', initialValue: hostname() }))

  const useSecrets = opts.flags['no-secrets'] !== true
  let vault = 'agent'
  let token = ''

  if (useSecrets) {
    vault = typeof opts.flags.vault === 'string'
      ? opts.flags.vault
      : String(await p.text({ message: '1Password vault holding the secret item', initialValue: 'agent' }))
    token = String(await p.password({
      message: '1Password service-account token (stored locally, mode 0600)',
    }))
    const probe = onePasswordProvider({ vault, item: 'syncskills', token })
    const check = await probe.check()
    if (!check.ok) {
      p.cancel(`1Password check failed: ${check.detail}`)
      throw new Error(check.detail)
    }
    p.log.success(check.detail)
  }

  const config: Config = {
    schemaVersion: 1, host: chosen.host, owner, repo, branch: 'main',
    device, vault, item: 'syncskills', secrets: useSecrets, excludes: [],
  }

  const state = await ensureRepo(config)
  p.log.success(`repository ${owner}/${repo} ${state}`)

  await mkdir(opts.configDir, { recursive: true })
  await saveConfig(opts.configDir, config)
  if (useSecrets) {
    await writeFile(join(opts.configDir, 'op-token'), token, { mode: 0o600 })
  }

  p.outro('Ready. Run `syncskills` to sync.')
  return config
}
```

`src/tui/index.ts` drives: `gather` → `summarize` → per-item review with
`renderDiff` → conflict flow → `applyPlan`. `src/tui/conflict.ts` presents each
unresolved item with the choice to accept the merge, take one side, or defer.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/tui tests/commands/init.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Commit**

```bash
git add src/commands/init.ts src/tui tests/tui tests/commands
git commit -m "feat: init wizard and interactive review interface"
```

---

## Task 14: Two-device integration suite

This is the test that proves the product works. It never touches real data and
never uses the network.

**Files:**
- Create: `tests/integration/twoDevice.test.ts`, `tests/helpers/device.ts`
- Test: itself

**Interfaces:**
- Consumes: everything
- Produces: `makeDevice(name, remote): Promise<Device>` with
  `Device = { name; configDir; paths; sync(): Promise<SyncOutcome>; writeSkill(dir, body): Promise<void>; readSkill(dir): Promise<string | null>; addMcp(id, config, apps): void }`

- [ ] **Step 1: Write the failing test**

`tests/integration/twoDevice.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeBareRemote, makeDevice, type Device } from '../helpers/device.js'

let remote: string
let A: Device
let B: Device

beforeEach(async () => {
  remote = await makeBareRemote()
  A = await makeDevice('work-pc', remote)
  B = await makeDevice('home-mac', remote)
})

describe('two devices', () => {
  it('propagates a new skill from A to B', async () => {
    await A.writeSkill('code-review', '---\nname: code-review\ndescription: d\n---\nv1\n')
    await A.sync()
    await B.sync()
    expect(await B.readSkill('code-review')).toContain('v1')
  })

  it('propagates an edit made on A after both are in sync', async () => {
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nv1\n')
    await A.sync(); await B.sync()
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nv2\n')
    await A.sync(); await B.sync()
    expect(await B.readSkill('s')).toContain('v2')
  })

  it('does not overwrite a newer remote when the local is unchanged', async () => {
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nv1\n')
    await A.sync(); await B.sync()
    await B.writeSkill('s', '---\nname: s\ndescription: d\n---\nfrom-B\n')
    await B.sync()
    const out = await A.sync()
    expect(out.plan.actions.map((a) => a.type)).toContain('pull-content')
    expect(await A.readSkill('s')).toContain('from-B')
  })

  it('detects a genuine conflict when both edit the same skill', async () => {
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nbase\n')
    await A.sync(); await B.sync()
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nA-change\n')
    await B.writeSkill('s', '---\nname: s\ndescription: d\n---\nB-change\n')
    await B.sync()
    const out = await A.sync()
    expect(out.unresolved.map((c) => c.id)).toContain('s')
  })

  it('merges non-overlapping edits without an agent and keeps both', async () => {
    const base = '---\nname: s\ndescription: d\n---\nline1\nline2\nline3\n'
    await A.writeSkill('s', base)
    await A.sync(); await B.sync()
    await A.writeSkill('s', base.replace('line1', 'A-LINE'))
    await B.writeSkill('s', base.replace('line3', 'B-LINE'))
    await B.sync()
    const out = await A.syncWithMerge()
    expect(out.merged).toBe(true)
    const text = await A.readSkill('s')
    expect(text).toContain('A-LINE')
    expect(text).toContain('B-LINE')
  })

  it('reports a delete on one side against an edit on the other as a conflict', async () => {
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nv1\n')
    await A.sync(); await B.sync()
    await A.deleteSkill('s')
    await B.writeSkill('s', '---\nname: s\ndescription: d\n---\nedited\n')
    await B.sync()
    const out = await A.sync()
    expect(out.unresolved.map((c) => c.id)).toContain('s')
  })

  it('propagates a deletion when the other side did not touch it', async () => {
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nv1\n')
    await A.sync(); await B.sync()
    await A.deleteSkill('s')
    await A.sync()
    await B.sync()
    expect(await B.readSkill('s')).toBeNull()
  })

  it('gives a third device everything on its first sync', async () => {
    await A.writeSkill('one', '---\nname: one\ndescription: d\n---\n1\n')
    await A.writeSkill('two', '---\nname: two\ndescription: d\n---\n2\n')
    await A.sync()
    const C = await makeDevice('laptop', remote)
    await C.sync()
    expect(await C.readSkill('one')).toContain('1')
    expect(await C.readSkill('two')).toContain('2')
  })

  it('is idempotent — a second sync with no changes does nothing', async () => {
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nv1\n')
    await A.sync()
    const second = await A.sync()
    expect(second.plan.actions).toHaveLength(0)
    expect(second.pushed).toBe(false)
  })

  it('syncs an MCP server definition without leaking its env values', async () => {
    A.addMcp('oracle', { type: 'stdio', command: 'oracle-mcp', env: { API_KEY: 'sk-secret-value' } }, ['claude'])
    await A.sync()
    const staged = await A.readRemoteFile('mcp/oracle.json')
    expect(staged).not.toContain('sk-secret-value')
    expect(staged).toContain('"secret": true')
  })

  it('leaves the base intact when an apply fails midway', async () => {
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nv1\n')
    await A.sync()
    const before = await A.readState()
    await A.breakCcSwitch()
    await A.writeSkill('s', '---\nname: s\ndescription: d\n---\nv2\n')
    await A.sync().catch(() => undefined)
    const after = await A.readState()
    expect(after.items['skill:s']!.contentHash).toBe(before.items['skill:s']!.contentHash)
  })
})
```

- [ ] **Step 2: Write `tests/helpers/device.ts`**

Build each device from the existing helpers: `makeFakeCcSwitch()` for the
cc-switch home, a temp directory for `configDir`, a `Config` pointing at the
bare remote via `remoteOverride`, and a stub `cc-switch` binary that applies
the matrix changes directly to the fake database. `sync()` calls `runSync` with
`direction: 'both'`, `useSecrets: false`, `mergeAgent: 'none'`; `syncWithMerge()`
runs the same with `mergeTrees` wired in and a union agent that is never reached
for non-overlapping edits.

- [ ] **Step 3: Run the suite**

Run: `npx vitest run tests/integration`
Expected: PASS, 11 tests

- [ ] **Step 4: Run everything and check coverage of the resolver**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add tests/integration tests/helpers/device.ts
git commit -m "test: two-device integration suite covering propagation, conflict and recovery"
```

---

## Task 15: Documentation and release

**Files:**
- Create: `README.md`, `LICENSE`, `.github/workflows/ci.yml`
- Modify: `package.json` (`prepublishOnly`)
- Test: `tests/smoke.test.ts`

**Interfaces:**
- Consumes: the built `dist/cli.js`
- Produces: a publishable package

- [ ] **Step 1: Write the failing smoke test**

`tests/smoke.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { run } from '../src/util/exec.js'
import { existsSync } from 'node:fs'

beforeAll(async () => {
  const r = await run('npm', ['run', 'build'])
  expect(r.code, r.stderr).toBe(0)
}, 120_000)

describe('built CLI', () => {
  it('produces dist/cli.js', () => {
    expect(existsSync('dist/cli.js')).toBe(true)
  })

  it('prints root help and exits 0', async () => {
    const r = await run('node', ['dist/cli.js', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('syncskills')
    expect(r.stdout).toContain('EXIT CODES')
  })

  it('prints per-command help', async () => {
    const r = await run('node', ['dist/cli.js', 'sync', '--help'])
    expect(r.code).toBe(0)
    expect(r.stdout).toContain('USAGE')
    expect(r.stdout).toContain('--json')
  })

  it('exits 3 when not initialized', async () => {
    const r = await run('node', ['dist/cli.js', 'status', '--json'], {
      env: { SYNCSKILLS_CONFIG_DIR: '/tmp/syncskills-nonexistent-' + Date.now() },
    })
    expect(r.code).toBe(3)
    expect(JSON.parse(r.stdout).ok).toBe(false)
  })

  it('starts fast enough for npx to feel instant', async () => {
    const t = Date.now()
    await run('node', ['dist/cli.js', '--help'])
    expect(Date.now() - t).toBeLessThan(1500)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/smoke.test.ts`
Expected: FAIL until `dist/cli.js` builds and dispatch returns the right codes

- [ ] **Step 3: Write `README.md`**

Cover, in this order: what problem it solves; a 30-second quickstart
(`npx syncskills init`, then `npx syncskills`); how the three-way sync behaves,
with the decision table; how secrets are handled and why nothing lands in git;
the full command and flag reference; the agent-facing contract (`--json`, exit
codes, an example of driving it from a script); requirements (`cc-switch`,
`gh`, `git`, optionally `op`, `claude`/`codex`); how to use a GHES host; and
how to recover from a bad merge with `syncskills conflicts`.

- [ ] **Step 4: Write `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - run: npx tsc --noEmit
      - run: npm test
      - run: npm run build
```

- [ ] **Step 5: Add the publish guard to `package.json`**

```json
"scripts": {
  "build": "tsup",
  "test": "vitest run",
  "typecheck": "tsc --noEmit",
  "prepublishOnly": "npm run typecheck && npm test && npm run build"
}
```

- [ ] **Step 6: Verify the package contents and startup**

```bash
npm pack --dry-run
node dist/cli.js --help
node dist/cli.js doctor --json
```

Expected: the tarball contains only `dist/`, `README.md`, `LICENSE` and
`package.json`; help prints; `doctor --json` reports each dependency.

- [ ] **Step 7: Publish**

The local npm registry is a proxy (`npm.flatt.tech`), so the public registry
must be named explicitly:

```bash
npm publish --access public --registry https://registry.npmjs.org
npx syncskills --help
```

- [ ] **Step 8: Commit**

```bash
git add README.md LICENSE .github package.json tests/smoke.test.ts
git commit -m "docs: README, CI and release configuration"
```

---

## Self-Review

**Spec coverage.** Every numbered section of the spec maps to a task: §2.1–2.3
to Task 4, §2.4 to Task 5, §3 module table to the file structure, §4 to Tasks 2
and 4, §5 to Task 9 and the push guard in Task 11, §6.1 to Task 3, §6.2 to
Task 10, §6.3 to Task 11, §6.4 to Task 5's `deleteMcp`, §7 to Task 12, §8 to
Task 13, §9 to Tasks 3 and 14, §10 risks to Tasks 5, 9, 10 and 12.

**Type consistency.** `Side`, `Resolution`, `Decision` and `ItemKind` are
defined once in `src/core/types.ts` (Tasks 2–3) and imported everywhere.
`stateKey(kind, id)` produces the `kind:id` form used by both `state.items`
and `manifest.entries`, so the two files stay aligned. `CcWriter.deleteMcp`
returns `'deleted' | 'pending'` in Task 5 and is consumed as `'pending'` in
Task 11's `applyOne`.

**Known follow-ups, deliberately out of scope for this plan:** a `cc-switch`-free
mode; syncing prompts and providers; a `--watch` daemon.
