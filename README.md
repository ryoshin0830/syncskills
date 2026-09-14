# syncskills

Keep your AI agent skills and MCP servers identical across every machine you work on.

```bash
npx syncskills init   # once per machine
npx syncskills        # from then on
```

`cc-switch` already unifies skills and MCP servers *within* one machine, across Claude Code,
Codex, Gemini, OpenCode, Hermes and Pi. It does not keep machines in agreement with each
other: uploads happen automatically, downloads only on demand, so devices drift apart.

`syncskills` is the missing half. One command performs a real three-way sync through a
GitHub repository you own, merges genuine conflicts instead of picking a loser, and keeps
every credential out of git.

---

## What it actually does

```
  work PC ─┐
           ├─→  github.com/you/syncskills  ←─┐
home Mac ──┘         (skills, MCP,          │
                      app matrix)           │
  always-on MacBook ─────────────────────────┘

  credentials never go here ──→  1Password (one secure note)
```

- **Three-way, not last-write-wins.** It remembers what you and the remote last agreed on,
  so it can tell "only I changed this" from "only they changed this" from "we both did".
  A remote that has moved on is never overwritten — that is a structural property of the
  decision table, not a timestamp comparison, so clock skew and `git clone`'s mtime reset
  cannot affect it.
- **Conflicts keep both sides.** `git merge-file` resolves non-overlapping edits for free
  and identically on every machine. Only genuine overlap reaches an AI agent
  (`claude -p` or `codex exec`), which is asked to preserve both contributions. Nothing it
  returns is written unless it validates, and both original versions are saved first.
- **No secrets in git, ever.** MCP `env` values live in a single 1Password secure note
  reached with a service-account token. The repository holds key names only. Every file
  staged for a push is scanned for credentials as a backstop.
- **Built for people and for agents.** Run it bare for an interactive review; pass flags
  and `--json` to drive it from a script. Exit codes say what happened.

## Requirements

| Tool | Why | Required |
| --- | --- | --- |
| Node ≥ 22.13 | `node:sqlite`, which reads cc-switch's database | yes |
| [`cc-switch`](https://github.com/farion1231/cc-switch) | owns the skills and MCP servers being synced | yes |
| `git`, `gh` | transport and authentication (GitHub or GHES) | yes |
| `op` (1Password CLI) | stores MCP credentials | only with secrets enabled |
| `claude` or `codex` | merges genuinely overlapping edits | optional |
| `expect` | answers cc-switch's delete confirmation | optional |

`syncskills doctor` checks all of them and tells you what to fix.

## Setup

```bash
npx syncskills init
```

It asks for a GitHub host and account (any GHES host works), a repository — created if it
does not exist — a 1Password vault, a service-account token, and a name for this machine.
The token is written to `~/.config/syncskills/op-token` with mode 0600 and never leaves
the machine.

Non-interactively:

```bash
SYNCSKILLS_OP_TOKEN=ops_... npx syncskills init \
  --host github.com --repo you/syncskills --vault agent --device work-pc --json
```

Repeat on each machine, pointing at the same repository, and give each one its own
`--device` name.

## Everyday use

```bash
npx syncskills              # interactive: review, resolve, apply
npx syncskills status       # what differs; changes nothing
npx syncskills sync --yes   # apply without prompting
npx syncskills diff code-review
```

## How it decides

For each item, with `B` = what both sides last agreed on, `L` = this machine,
`R` = the remote:

| B | L | R | What happens |
| --- | --- | --- | --- |
| A | A | A | nothing |
| A | **B'** | A | push — only you changed it |
| A | A | **B'** | pull — only they changed it |
| — | X | — | push, it is new here |
| — | — | X | pull, it is new there |
| A | — | A | delete on the remote too |
| A | A | — | delete here too |
| A | **X** | **Y** | **conflict** → merge, keeping both |
| A | — | **Y** | **conflict** — you deleted it, they changed it |

The app matrix — which harnesses each item is enabled for — resolves separately, so a
machine that enables a skill for Hermes does not fight a machine that edited its text.

## Driving it from a script or an agent

Every command takes `--json` and returns a stable envelope:

```bash
npx syncskills status --json | jq '.data.items[] | select(.decision != "IN_SYNC")'
npx syncskills sync --yes --json
```

```
Exit codes
  0  success
  1  error
  2  unresolved conflicts, or an action awaiting you
  3  not initialized
```

So a wrapper can be exactly this:

```bash
npx syncskills sync --yes --json > result.json
case $? in
  0) echo "in sync" ;;
  2) echo "needs a human"; jq '.data.unresolved' result.json ;;
  *) jq -r '.error' result.json >&2; exit 1 ;;
esac
```

`--help` on any subcommand lists every flag with worked examples.

## Flags

```
--json                 machine-readable output
--yes, -y              assume yes; never prompt
--dry-run              show what would happen; change nothing
--only <kinds>         skills, mcp, repos
--merge-agent <name>   claude | codex | none   (default: auto)
--no-secrets           do not touch 1Password
--profile <name>       a second repository/config set
--config <dir>         configuration directory
--verbose, --quiet, --no-tui, --help
```

## When a merge goes wrong

Both original versions are saved before anything is written:

```bash
npx syncskills conflicts                       # list snapshots
npx syncskills conflicts restore <id>          # put one back
```

Every apply also snapshots the cc-switch database and your whole skills tree to
`~/.config/syncskills/backups/<timestamp>/` first.

## Where things live

```
~/.config/syncskills/
├── config.json     host, repository, vault, device name
├── state.json      what this machine and the remote last agreed on
├── op-token        1Password service-account token (0600)
├── backups/        pre-apply snapshots
├── conflicts/      both sides of every conflict resolved
└── cache/repo/     the git working copy

~/.cc-switch/
├── cc-switch.db    read-only to syncskills
└── skills/         the skill content being synced
```

## Design notes

The full design and the verified integration contract with cc-switch are in
[`docs/superpowers/specs/`](docs/superpowers/specs/). Two things worth knowing:

- cc-switch's `skills.updated_at` is zero on every row, so there is no trustworthy
  timestamp to sync on. `state.json` exists because of that.
- MCP servers live only inside cc-switch's SQLite database, and `mcp delete` requires a
  TTY. Writes go through a base64 `ccswitch://v1/import` deep link, `set-apps`, and — for
  deletion — a pseudo-terminal, falling back to a guarded direct row delete that refuses
  to run while cc-switch is live.

## License

MIT
