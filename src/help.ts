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
  --no-secrets         set up without 1Password
  --json               machine-readable result

EXAMPLES
  syncskills init
  syncskills init --host github.com --repo me/syncskills --vault agent --device work-pc
  syncskills init --no-secrets --json`,

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

Only key names are ever printed. Values are never displayed.

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
