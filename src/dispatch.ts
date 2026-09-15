import { EXIT } from './cli.js'
import { configDir, loadConfig } from './config.js'
import { resolveCcPaths } from './ccswitch/paths.js'
import { readToken } from './engine.js'
import { emitJsonError } from './output.js'
import { Cancelled } from './prompt.js'
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
import { parseOnly, parseAgent } from './flags.js'
import type { EngineOptions, Direction } from './engine.js'
import type { ItemKind } from './core/types.js'

/** Commands that are useful before anything has been set up. */
const WITHOUT_CONFIG = new Set(['init', 'doctor', 'config', 'completion', 'help'])

const KNOWN = new Set([
  'tui', 'init', 'sync', 'status', 'push', 'pull', 'diff',
  'conflicts', 'secrets', 'doctor', 'config', 'completion', 'help',
])

/**
 * Report a failure the way the caller asked to be spoken to.
 *
 * Every exit from this module goes through here, including the ones that come
 * out of a command as an exception: a script that asked for `--json` must get
 * an envelope whatever happens, and "the process died with an empty stdout" is
 * the one answer it cannot parse.
 */
function fail(command: string, message: string, io: Io): number {
  if (io.json) emitJsonError(command, message, io)
  else process.stderr.write(`syncskills: ${message}\n`)
  return EXIT.ERROR
}

export async function dispatch(args: ParsedArgs, json: boolean): Promise<number> {
  const io: Io = {
    json,
    quiet: args.flags.quiet === true,
    verbose: args.flags.verbose === true,
    warnings: [],
  }
  try {
    return await run(args, io)
  } catch (e) {
    // An interrupt is not a failure, but it is not a success either: exiting 0
    // would let `syncskills && deploy` run off the end of a cancelled sync.
    if (e instanceof Cancelled) {
      if (io.json) emitJsonError(args.command, (e as Error).message, io)
      return EXIT.CANCELLED
    }
    return fail(args.command, (e as Error).message, io)
  }
}

async function run(args: ParsedArgs, io: Io): Promise<number> {
  const profile = typeof args.flags.profile === 'string' ? args.flags.profile : undefined
  const baseDir = configDir({
    ...(typeof args.flags.config === 'string' ? { config: args.flags.config } : {}),
  })
  const dir = profile === undefined ? baseDir : `${baseDir}/profiles/${profile}`

  const paths = resolveCcPaths()

  // Check the command name before anything else, so a typo reports itself
  // rather than being reported as a missing configuration.
  if (!KNOWN.has(args.command)) {
    return fail(args.command, `unknown command "${args.command}" — run \`syncskills --help\``, io)
  }

  const only = parseOnly(args.flags.only)
  const mergeAgent = parseAgent(args.flags['merge-agent'])

  if (args.command === 'completion') {
    return completionCommand(args.positionals[0], io)
  }
  if (args.command === 'config') {
    return configCommand(dir, args.positionals, io)
  }

  const config = await loadConfig(dir)

  const token = await readToken(dir)

  if (args.command === 'doctor') {
    return doctorCommand({ paths, config, ...(token === undefined ? {} : { token }) }, io)
  }

  if (args.command === 'init') {
    const { runInit } = await import('./commands/init.js')
    await runInit({ configDir: dir, flags: args.flags, io })
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
    mergeAgent,
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

    default:
      return fail(args.command, `unknown command "${args.command}" — run \`syncskills --help\``, io)
  }
}
