import { EXIT } from './cli.js'
import { configDir, loadConfig } from './config.js'
import { resolveCcPaths } from './ccswitch/paths.js'
import { readToken } from './engine.js'
import { emitJsonError } from './output.js'
import { statusCommand } from './commands/status.js'
import { syncCommand } from './commands/sync.js'
import { doctorCommand } from './commands/doctor.js'
import { configCommand } from './commands/configCmd.js'
import { completionCommand } from './commands/completion.js'
import { secretsCommand } from './commands/secretsCmd.js'
import { conflictsCommand } from './commands/conflicts.js'
import { diffCommand } from './commands/diff.js'
import type { ParsedArgs } from './cli.js'
import type { Io } from './output.js'
import type { EngineOptions, Direction } from './engine.js'
import type { ItemKind } from './core/types.js'

/** Commands that are useful before anything has been set up. */
const WITHOUT_CONFIG = new Set(['init', 'doctor', 'config', 'completion', 'help'])

const KNOWN = new Set([
  'tui', 'init', 'sync', 'status', 'push', 'pull', 'diff',
  'conflicts', 'secrets', 'doctor', 'config', 'completion', 'help',
])

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

function parseAgent(value: string | boolean | undefined): EngineOptions['mergeAgent'] {
  return value === 'claude' || value === 'codex' || value === 'none' ? value : 'auto'
}

export async function dispatch(args: ParsedArgs, json: boolean): Promise<number> {
  const io: Io = {
    json,
    quiet: args.flags.quiet === true,
    verbose: args.flags.verbose === true,
    warnings: [],
  }

  const profile = typeof args.flags.profile === 'string' ? args.flags.profile : undefined
  const baseDir = configDir({
    ...(typeof args.flags.config === 'string' ? { config: args.flags.config } : {}),
  })
  const dir = profile === undefined ? baseDir : `${baseDir}/profiles/${profile}`

  const paths = resolveCcPaths()

  // Check the command name before anything else, so a typo reports itself
  // rather than being reported as a missing configuration.
  if (!KNOWN.has(args.command)) {
    const msg = `unknown command "${args.command}" — run \`syncskills --help\``
    if (io.json) emitJsonError(args.command, msg, io)
    else process.stderr.write(`syncskills: ${msg}\n`)
    return EXIT.ERROR
  }

  // Argument errors are reported before anything about the machine's state: a
  // misspelled kind is wrong whether or not this device has been set up.
  let only: ItemKind[] | undefined
  try {
    only = parseOnly(args.flags.only)
  } catch (e) {
    const msg = (e as Error).message
    if (io.json) emitJsonError(args.command, msg, io)
    else process.stderr.write(`syncskills: ${msg}\n`)
    return EXIT.ERROR
  }

  if (args.command === 'completion') {
    return completionCommand(args.positionals[0], io)
  }
  if (args.command === 'config') {
    return configCommand(dir, args.positionals, io)
  }

  let config
  try {
    config = await loadConfig(dir)
  } catch (e) {
    const msg = (e as Error).message
    if (io.json) emitJsonError(args.command, msg, io)
    else process.stderr.write(`syncskills: ${msg}\n`)
    return EXIT.ERROR
  }

  const token = await readToken(dir)

  if (args.command === 'doctor') {
    return doctorCommand({ paths, config, ...(token === undefined ? {} : { token }) }, io)
  }

  if (args.command === 'init') {
    const { runInit } = await import('./commands/init.js')
    try {
      await runInit({ configDir: dir, flags: args.flags, io })
    } catch (e) {
      const msg = (e as Error).message
      if (io.json) emitJsonError('init', msg, io)
      else process.stderr.write(`syncskills: ${msg}\n`)
      return EXIT.ERROR
    }
    return EXIT.OK
  }

  if (config === null && !WITHOUT_CONFIG.has(args.command)) {
    const msg = 'not initialized — run `syncskills init`'
    if (io.json) emitJsonError(args.command, msg, io)
    else process.stderr.write(`syncskills: ${msg}\n`)
    return EXIT.UNINITIALIZED
  }
  if (config === null) return EXIT.UNINITIALIZED

  const useSecrets = args.flags['no-secrets'] !== true && config.secrets

  const engine: EngineOptions = {
    configDir: dir,
    config,
    paths,
    ...(only === undefined ? {} : { only }),
    mergeAgent: parseAgent(args.flags['merge-agent']),
    useSecrets,
    dryRun: args.flags['dry-run'] === true,
    direction: 'both' as Direction,
    ...(token === undefined ? {} : { token }),
  }

  switch (args.command) {
    case 'status':
      return statusCommand(engine, io)

    case 'sync':
      return syncCommand(engine, io, 'sync')

    case 'push':
      return syncCommand({ ...engine, direction: 'push' }, io, 'push')

    case 'pull':
      return syncCommand({ ...engine, direction: 'pull' }, io, 'pull')

    case 'diff':
      return diffCommand(engine, args.positionals[0], io)

    case 'conflicts':
      return conflictsCommand({ configDir: dir, paths }, args.positionals, io)

    case 'secrets':
      return secretsCommand(
        { config, useSecrets, ...(token === undefined ? {} : { token }) },
        args.positionals[0],
        io,
      )

    case 'tui': {
      const { runTui } = await import('./tui/index.js')
      return runTui(engine, io)
    }

    default: {
      const msg = `unknown command "${args.command}" — run \`syncskills --help\``
      if (io.json) emitJsonError(args.command, msg, io)
      else process.stderr.write(`syncskills: ${msg}\n`)
      return EXIT.ERROR
    }
  }
}
