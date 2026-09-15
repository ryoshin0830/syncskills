import type { ItemKind } from './core/types.js'
import type { EngineOptions } from './engine.js'

/**
 * Everything that can be wrong with a command line, decided before anything is
 * read from disk: a misspelled kind, an agent that does not exist, or a flag
 * this command has no use for is wrong whether or not the device is set up.
 */
const KIND_OF: Record<string, ItemKind> = {
  skill: 'skill', skills: 'skill',
  mcp: 'mcp', mcps: 'mcp',
  repo: 'repo', repos: 'repo',
}

/**
 * Parse `--only`. A name that is not a kind is an error, not a reason to fall
 * back to syncing everything: `--only skil` silently touching MCP servers and
 * repositories is the opposite of what was asked for.
 */
export function parseOnly(value: string | boolean | undefined): ItemKind[] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--only needs a value: skills, mcp or repos (comma separated)')
  }
  const names = value.split(',').map((s) => s.trim()).filter((s) => s !== '')
  const bad = names.filter((n) => KIND_OF[n] === undefined)
  if (bad.length > 0) {
    throw new Error(
      `--only: unknown kind${bad.length > 1 ? 's' : ''} ${bad.map((b) => `"${b}"`).join(', ')} ` +
      `— expected skills, mcp or repos`,
    )
  }
  return [...new Set(names.map((n) => KIND_OF[n]!))]
}

/**
 * Parse `--merge-agent`, held to the same standard as `--only`: a name we do
 * not know is a typo, and quietly substituting `auto` means the run uses an
 * agent the user did not ask for.
 */
export function parseAgent(value: string | boolean | undefined): EngineOptions['mergeAgent'] {
  if (value === undefined) return 'auto'
  if (value === 'claude' || value === 'codex' || value === 'none' || value === 'auto') return value
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--merge-agent needs a value: claude, codex, none or auto')
  }
  throw new Error(`--merge-agent: unknown agent "${value}" — expected claude, codex, none or auto`)
}

/** Flags that mean the same thing everywhere, so every command takes them. */
const GLOBAL_FLAGS = ['json', 'quiet', 'verbose', 'help', 'version', 'config', 'profile']

/**
 * What each command actually reads.
 *
 * Refusing an unknown flag left a gap: a flag that exists but does nothing here
 * is just as silent. `sync --merge-agent codex` is the sharp case — the help
 * says in so many words that sync does not merge, and passing it anyway
 * succeeded with no output at all.
 */
const FLAGS_FOR: Record<string, string[]> = {
  tui: ['only', 'dry-run', 'no-secrets', 'merge-agent', 'no-tui', 'yes'],
  init: ['host', 'repo', 'vault', 'device', 'no-secrets', 'yes'],
  sync: ['only', 'dry-run', 'no-secrets', 'yes'],
  push: ['only', 'dry-run', 'no-secrets', 'yes'],
  pull: ['only', 'dry-run', 'no-secrets', 'yes'],
  status: ['only', 'no-secrets'],
  diff: ['only', 'no-secrets'],
  conflicts: [],
  secrets: ['no-secrets'],
  doctor: ['no-secrets'],
  config: [],
  completion: [],
  help: [],
}

/** Flags this command has no use for, sorted. Short aliases are resolved already. */
export function flagsNotUsedBy(
  command: string, flags: Record<string, string | boolean>,
): string[] {
  const allowed = new Set([...GLOBAL_FLAGS, ...(FLAGS_FOR[command] ?? [])])
  return Object.keys(flags).filter((f) => !allowed.has(f)).sort()
}
