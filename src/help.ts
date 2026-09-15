const GLOBAL = `GLOBAL FLAGS  (accepted by every command)
  --json                 machine-readable output
  --profile <name>       use an alternate configuration
  --config <dir>         configuration directory (default: ~/.config/syncskills)
  --version              print the version
  --verbose, -v          more detail
  --quiet, -q            errors only
  --help, -h             show help

Other flags belong to particular commands and are refused elsewhere — see the
per-command help. \`--merge-agent\` in particular is read only by the
interactive interface, which is the only place a merge happens.`

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
  0    success
  1    error
  2    unresolved conflicts, or an action awaiting manual intervention
  3    not initialized — run \`syncskills init\`
  130  cancelled with Ctrl-C; nothing was changed

MERGING
  Conflicts are merged in the interactive interface only, where the merged
  result is shown before it is written. \`sync\`, \`push\` and \`pull\` report a
  conflict and leave the item alone; run \`syncskills\` with no arguments to
  resolve one. \`--merge-agent\` chooses the agent for that interactive merge.

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
  --no-secrets         do not touch 1Password
  --json               machine-readable result

Conflicts are NOT merged here. This command never rewrites an item out of two
versions on its own; it reports the conflict and moves on, leaving both sides
intact. Run \`syncskills\` with no arguments to merge one interactively, where
the result is shown before it is written.

EXIT CODES
  1 when an item could not be applied, or when another device published to the
    store first — in which case nothing was sent and running sync again picks
    up from where the other device left off.
  2 when an item is in conflict, or is waiting for you to finish it by hand.

EXAMPLES
  syncskills sync
  syncskills sync --yes --json
  syncskills sync --only mcp`,

  status: `syncskills status — show what differs.

USAGE
  syncskills status [flags]

Reads this device, the remote and the saved base, and reports a decision for
every item. Changes nothing, touches no files, and is safe to run at any time.

FLAGS
  --only <kinds>   skills, mcp, repos
  --no-secrets     do not touch 1Password
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
  --yes, -y        apply without prompting
  --dry-run        show the plan and stop
  --only <kinds>   skills, mcp, repos
  --no-secrets     do not touch 1Password
  --json           machine-readable result

EXAMPLES
  syncskills push --dry-run
  syncskills push --yes --json`,

  pull: `syncskills pull — take remote changes only.

USAGE
  syncskills pull [flags]

Applies only inbound actions. Local-only changes are left untouched and
reported, so nothing you have here is lost.

FLAGS
  --yes, -y        apply without prompting
  --dry-run        show the plan and stop
  --only <kinds>   skills, mcp, repos
  --no-secrets     do not touch 1Password
  --json           machine-readable result

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
