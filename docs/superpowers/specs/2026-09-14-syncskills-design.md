# syncskills — Design Spec

**Date:** 2026-09-14
**Status:** Approved
**npm:** `syncskills` · **repo:** `github.com/ryoshin0830/syncskills`

---

## 1. Problem

A single person runs several AI coding harnesses (Claude Code, Codex, Pi, Hermes
Agent) across several machines (work PC, personal PC, an always-on MacBook for
Hermes). `cc-switch` already unifies skills and MCP servers *within* one machine,
but it does not keep machines in agreement with each other. Its built-in sync
uploads automatically and downloads only on demand, so devices drift apart and
the feature goes unused.

`syncskills` is the missing half: one command, `npx syncskills`, that makes every
device converge on the same set of skills and MCP servers, with real difference
tracking and no silent data loss.

### Goals

- One command performs a correct bidirectional sync.
- Never lose an edit, on any device, under any ordering.
- A GitHub (or GHES) repository is the durable, diffable store.
- Equally usable by a human (TUI) and by an agent (flags, `--json`, exit codes).
- Distributable as OSS: any host, any repo, any vault.

### Non-goals

- Replacing `cc-switch`. It is a hard prerequisite; `syncskills` drives it.
- A `cc-switch`-free mode. Deferred to a later project.
- Syncing providers or API credentials for the harnesses themselves.

---

## 2. Findings that constrain the design

Everything below was verified on a live machine before this spec was written.

### 2.1 cc-switch stores metadata in SQLite, content on disk

```
~/.cc-switch/
├── cc-switch.db          SQLite, 27 MB — metadata SSOT
│   ├── skills            id, name, description, directory, repo_owner,
│   │                     repo_name, repo_branch, content_hash, installed_at,
│   │                     updated_at, enabled_{claude,codex,gemini,opencode,
│   │                     hermes,grokbuild}
│   ├── mcp_servers       id, name, server_config (JSON string), description,
│   │                     homepage, docs, tags, enabled_*
│   └── skill_repos       owner, name, branch, enabled
└── skills/<dir>/         skill content SSOT — ordinary files

~/.claude/skills/<dir> → symlink → ~/.cc-switch/skills/<dir>
```

`skills sync-method` is `Symlink`; `skills storage-location` is `cc-switch`.
Both are user-configurable and must be read, never assumed.

### 2.2 `skills.updated_at` is unusable

Every row carries `updated_at = 0`. cc-switch offers no trustworthy per-item
timestamp. **This single fact forces `syncskills` to maintain its own version
state**, and rules out any design that compares cc-switch timestamps.

`content_hash` (sha256) and `installed_at` do exist and are meaningful.

### 2.3 MCP servers exist only inside SQLite

There is no file representation. `server_config` is a JSON string column whose
`env` object is the conventional home of API keys.

### 2.4 Write paths into cc-switch (verified empirically)

| Operation | Mechanism | Non-interactive |
| --- | --- | --- |
| Create MCP / add apps | `cc-switch deeplink "ccswitch://v1/import?resource=mcp&apps=<csv>&config=<b64>"` | yes |
| Replace MCP app matrix | `cc-switch mcp set-apps <id> --apps <csv>` | yes |
| Replace skill app matrix | `cc-switch skills set-apps <dir> --apps <csv>` | yes |
| Import skill from disk | `cc-switch skills import-from-apps <dir> --apps <csv>` | yes |
| Update MCP `server_config` | delete, then deeplink | delete needs a TTY |
| Delete MCP | `cc-switch mcp delete <id>` | needs a TTY |

The deeplink `config` parameter must be **URL-safe Base64 of a JSON document
containing an `mcpServers` object**, then URL-escaped. Passing raw JSON fails
with a Base64 decode error.

Deeplink import is **additive**: re-importing an existing id adds apps to the
matrix but leaves `server_config` untouched. Updating a config therefore
requires delete-then-import.

`cc-switch mcp delete` prompts for confirmation and rejects piped stdin
("The input device is not a TTY"). No environment variable disables the prompt.

### 2.5 Useful environment variables

`CC_SWITCH_CONFIG_DIR` and `CC_SWITCH_TEST_HOME` redirect cc-switch at a
different home. Integration tests use them to avoid touching real data.

### 2.6 List output is not machine-readable

`cc-switch mcp list` and `skills list` render box-drawing tables with no `--json`
flag. Reads therefore go straight to SQLite in read-only mode.

### 2.7 1Password

`op` 2.34.1 is installed. A service-account token grants access to one vault
(`agent`). A `SECURE_NOTE` item stores arbitrary text in a single field
(`id: notesPlain`, `purpose: NOTES`); an existing item in this vault holds an
18 KB payload, so a JSON blob of secrets is well within limits.

### 2.8 Merge agents

`claude` 2.1.270 supports `-p/--print` with `--output-format`, `--model`,
`--allowedTools`, `--permission-mode`. `codex` 0.153.4 supports `codex exec`
reading a prompt from stdin. Either can perform a non-interactive merge.

---

## 3. Architecture

```
             GitHub / GHES   <owner>/<repo>
             ├── manifest.json     index: per-item hash, version, updated_by/at
             ├── skills/<dir>/…    skill content, verbatim files
             ├── mcp/<id>.json     MCP config, env values replaced by key names
             └── repos.json        skill_repos
                       ▲ ▼  git over the local `gh` credential helper
             ~/.config/syncskills/
             ├── config.json       host, repo, vault, device name, excludes
             ├── state.json    ★   BASE hashes — the three-way merge base
             ├── op-token          1Password service-account token, mode 0600
             ├── conflicts/<ts>/   pre-merge snapshots of both sides
             └── cache/repo/       git working copy
                       ▲ ▼
             cc-switch adapter
             ├─ read   sqlite3 cc-switch.db (read-only) + ~/.cc-switch/skills/
             └─ write  deeplink · set-apps · import-from-apps · skills sync
                       ▲ ▼
             1Password  vault: <configurable>
             └─ SECURE_NOTE "syncskills" → notesPlain = { "mcp": { … env … } }
```

### Module boundaries

Each module is independently testable and depends only on interfaces.

| Module | Responsibility | Depends on |
| --- | --- | --- |
| `ccswitch/read` | Read skills, MCP, repos, paths from SQLite and disk | sqlite file |
| `ccswitch/write` | Apply a resolved plan through cc-switch | `cc-switch` binary |
| `hash` | Deterministic tree hash of a directory; canonical hash of a JSON item | — |
| `state` | Load/save `state.json`, the BASE record | fs |
| `store/git` | Clone, read, stage, commit, push, pull the remote repo | `git`, `gh` |
| `store/manifest` | Serialize and parse `manifest.json` | — |
| `secrets` | `SecretProvider` interface; 1Password implementation | `op` |
| `resolve` | Pure three-way decision table; no I/O | — |
| `merge` | `git merge-file`, then `MergeAgent`; validate results | `git`, agent CLI |
| `plan` | Turn resolutions into an ordered, reviewable list of actions | — |
| `apply` | Execute a plan; write backups first | `ccswitch/write`, `store` |
| `cli` | Argument parsing, `--json`, exit codes, help text | all |
| `tui` | Interactive flows over the same engine | all |

`resolve` contains the correctness-critical logic and has no I/O, so it can be
tested exhaustively.

---

## 4. Item model

An **item** is the unit of synchronization.

| Kind | Identity | Content |
| --- | --- | --- |
| `skill` | directory name | the directory tree |
| `mcp` | server id | canonicalized `server_config` + `env` key names |
| `repo` | `owner/name` | branch, enabled |

Every item also carries an **app matrix**: the set of harnesses it is enabled
for. The matrix is synced as part of the item.

### Content hashing

```
tree_hash(dir) = sha256 over, for each file sorted by POSIX relative path:
                   relpath \0 mode(exec bit only) \0 sha256(bytes) \0
```

Symlinks are resolved to their targets. Ignored everywhere: `.DS_Store`,
`.git/`, `node_modules/`, `__pycache__/`, `*.pyc`.

For `mcp` and `repo` items the hash is taken over a canonical JSON form (sorted
keys, no insignificant whitespace, secret values excluded). Canonicalization
matters: an identical config must hash identically on every device.

---

## 5. Secrets

The repository never receives a secret value.

```
repo   mcp/oracle.json     { "env": { "API_KEY": { "secret": true } } }
1P     notesPlain          { "mcp": { "oracle": { "env": { "API_KEY": "sk-…" } } } }
local  ~/.config/syncskills/op-token   service-account token, mode 0600
```

- `syncskills init` prompts for the service-account token and the vault name,
  verifies them with `op whoami` and `op vault list`, and writes the token with
  mode 0600.
- On **push**, each MCP `env` value is stripped to its key name in the repo and
  the real value is written into the 1Password JSON blob.
- On **pull**, `env` values are read back from 1Password. A key absent from the
  blob is reported, and the local value (if any) is preserved rather than
  overwritten with an empty string.
- `--no-secrets` skips 1Password entirely; MCP items still sync, with `env`
  values left untouched locally.
- The blob is read and written whole, under the same three-way rules as any
  other item, so concurrent secret edits cannot silently clobber each other.

A pre-push guard scans every outgoing payload for high-entropy strings and
known key prefixes and aborts the push if one is found. This is a backstop
against a bug in the stripping logic, not the primary defense.

---

## 6. The sync engine

### 6.1 Three-way resolution

For each item id in `union(base, local, remote)`, with `B` = base hash,
`L` = local hash, `R` = remote hash, and `∅` = absent:

| B | L | R | Condition | Decision |
| --- | --- | --- | --- | --- |
| any | X | X | `L == R` | `IN_SYNC` — refresh base |
| B | X | B | `L ≠ B`, `R == B` | `PUSH` |
| B | B | Y | `L == B`, `R ≠ B` | `PULL` |
| ∅ | X | ∅ | | `PUSH_NEW` |
| ∅ | ∅ | Y | | `PULL_NEW` |
| ∅ | X | Y | `X ≠ Y` | `CONFLICT` (independent creation) |
| B | ∅ | B | | `DELETE_REMOTE` |
| B | B | ∅ | | `DELETE_LOCAL` |
| B | X | Y | `X ≠ B`, `Y ≠ B`, `X ≠ Y` | `CONFLICT` (concurrent edit) |
| B | ∅ | Y | `Y ≠ B` | `CONFLICT` (delete vs edit) |
| B | X | ∅ | `X ≠ B` | `CONFLICT` (edit vs delete) |

The requirement "if the remote is newer, do not overwrite it" is guaranteed by
row 3 as a structural property, not by comparing clocks. Clock skew and the
mtime reset that `git clone` performs cannot affect the outcome.

The app matrix is resolved by the same table, independently of content, so a
device that enables a skill for Hermes does not fight a device that edited the
skill's text.

`state.json` is written **only after** the corresponding action has been applied
and verified. An interrupted run therefore re-runs safely: the base still
describes the last state both sides agreed on.

### 6.2 Conflict resolution — merge, keep both

A conflict never discards a side. Resolution proceeds per file inside the item:

```
1. Materialize base/, local/, remote/ into a temp directory.
2. For each file path in the union of the three trees:
     identical on both sides        → take it
     changed on one side only       → take the changed side
     added on one side only         → take it
     changed on both sides          → step 3
3. git merge-file --diff3 local base remote
     exit 0 (clean)                 → take the merged result
     conflict markers remain        → step 4
4. MergeAgent: `claude -p` (default) or `codex exec` (--merge-agent codex).
     Prompt: preserve the intent of BOTH sides; never drop one side's content;
     output only the merged file, no commentary.
5. Validate the agent's output:
     non-empty
     no conflict markers (<<<<<<<, =======, >>>>>>>)
     if SKILL.md: frontmatter parses as YAML and retains `name` + `description`
     if JSON: parses
   Any failure → discard the agent result and fall back to manual choice.
6. Snapshot both original sides to ~/.config/syncskills/conflicts/<ts>/<item>/
   before writing anything.
7. Present the diff for approval. `--yes` accepts automatically.
```

Running `git merge-file` first means the merge agent is invoked only for
genuinely overlapping edits. That keeps the common case deterministic, fast and
free, and leaves the system fully functional when no agent is installed
(`--merge-agent none`, or nothing on `PATH`, degrades to manual choice).

### 6.3 Applying a plan

Order is fixed so that a partial failure leaves a consistent state:

```
1. Snapshot: copy cc-switch.db and every affected skill directory into
   ~/.config/syncskills/backups/<ts>/
2. Pull operations   — write skill directories, then register via cc-switch
3. MCP operations    — deeplink for create; delete-then-import for update
4. Matrix operations — skills set-apps / mcp set-apps
5. cc-switch skills sync  (rebuild the symlinks in every app directory)
6. Push operations   — stage, commit, push
7. Update state.json — only for actions confirmed successful
```

Each step is independently verified; a failure aborts the remainder, reports
precisely what was and was not applied, and leaves `state.json` describing
reality.

### 6.4 The TTY problem

`cc-switch mcp delete` requires a TTY. Three strategies, tried in order:

1. Spawn it under a pseudo-terminal using `script(1)` on macOS or `expect` when
   present, answering the prompt.
2. Fall back to deleting the row directly from SQLite and then running
   `cc-switch mcp sync` to regenerate the live configuration files.
3. If neither is possible, report the deletion as *pending manual action* with
   the exact command to run, and exit 2.

Direct SQLite writes are guarded: refuse if a `cc-switch` process or the
ccswitch desktop app is running, take the `state-mutation.lock` file, run inside
a transaction, and verify `PRAGMA integrity_check` afterwards. A backup of the
database is always taken first.

---

## 7. CLI surface

`syncskills` with no arguments launches the TUI. Any argument selects
non-interactive mode. Both drive the same engine.

```
syncskills                      TUI
syncskills init                 setup wizard
syncskills sync                 bidirectional sync
syncskills status               show differences, no side effects
syncskills push | pull          one direction only
syncskills diff <item>          diff a single item
syncskills conflicts            list and restore snapshots
syncskills secrets <push|pull|list>
syncskills doctor               environment diagnosis
syncskills config <get|set|path>
syncskills completion <zsh|bash|fish>
```

Global flags:

```
--json                machine-readable output, every command
--yes, -y             assume yes; no prompts
--dry-run             plan only, change nothing
--only skills|mcp|repos
--merge-agent claude|codex|none
--profile <name>      a second repository/config set
--no-secrets          skip 1Password
--verbose, --quiet, --no-tui, --config <path>
```

Exit codes:

```
0  success
1  error
2  unresolved conflicts, or an action pending manual intervention
3  not initialized
```

An agent reads `syncskills status --json`, applies with
`syncskills sync --yes --json`, and detects unresolved conflicts by exit
code 2. `--help` on every subcommand carries a description, every flag, and
worked examples.

### `--json` shape

```json
{
  "schemaVersion": 1,
  "device": "work-pc",
  "items": [
    { "kind": "skill", "id": "code-review", "decision": "PUSH",
      "local": "sha256:…", "remote": "sha256:…", "base": "sha256:…" }
  ],
  "conflicts": [],
  "applied": [],
  "warnings": []
}
```

---

## 8. TUI

Built on `@clack/prompts` with hand-rendered diffs, chosen over Ink because
`npx` re-downloads the package on every invocation: ~150 KB and instant startup
against ~2–3 MB and a perceptible delay. No full-screen pane layout is required
by any flow.

- **init** — host → account → repository → vault → token → device name, each
  step validated before the next.
- **review** — items grouped by decision, with counts; expand for a diff.
- **conflict** — side-by-side summary, the merge result, and the choice to
  accept, edit, take one side, or defer.
- Colour is disabled under `NO_COLOR` and when stdout is not a TTY.

---

## 9. Testing

Development is test-first.

1. **`resolve` unit tests.** The decision table above, exhaustively: every
   combination of present/absent and equal/different across `B`, `L`, `R`,
   for content and for the app matrix. If this module is right, data loss is
   structurally impossible.
2. **Two-device integration tests.** Two fake homes (`CC_SWITCH_CONFIG_DIR`)
   and a local bare git repository standing in for the remote. No network.
   Scenarios: edit on A propagates to B; both edit the same skill; A deletes
   while B edits; a third device joins and pulls everything; an interrupted
   apply is resumed.
3. **Merge.** `git merge-file` paths with real fixtures; `MergeAgent` mocked by
   default; one opt-in test against the real CLIs.
4. **Secrets.** `SecretProvider` mocked; tests assert that no secret value ever
   reaches a staged file.
5. **cc-switch adapter.** Reads run against a copied database; writes run
   against a stub binary that records its arguments.

---

## 10. Risks

| Risk | Mitigation |
| --- | --- |
| MCP delete needs a TTY | pty → SQLite fallback → report as pending (§6.4) |
| Direct SQLite writes race with cc-switch | process check, lock file, transaction, integrity check, backup |
| cc-switch schema changes | adapter is isolated; `doctor` verifies the schema and version and refuses to run against an unknown shape |
| Merge agent returns damaged content | validated in §6.2 step 5; discarded on failure |
| A secret reaches the repository | stripping plus an independent pre-push entropy scan |
| `npx` startup feels slow | small dependency set, bundled output, no native modules |

---

## 11. Roadmap

| Phase | Content |
| --- | --- |
| 0 | ~~Spike: confirm the MCP write path~~ — **done, recorded in §2.4** |
| 1 | Project skeleton: TypeScript, tsup, vitest, CI, CLI framing, exit codes |
| 2 | cc-switch adapter: SQLite reads, tree hashing, write operations |
| 3 | Three-way engine with the exhaustive test suite |
| 4 | Git store: `gh` auth, GHES support, manifest |
| 5 | 1Password secrets layer |
| 6 | Merge: `git merge-file`, merge agents, validation, snapshots |
| 7 | TUI |
| 8 | Two-device integration suite |
| 9 | README, `npx syncskills` verification, publish to npm |
