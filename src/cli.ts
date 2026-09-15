export const EXIT = {
  OK: 0, ERROR: 1, CONFLICT: 2, UNINITIALIZED: 3,
  /** The user interrupted. 128 + SIGINT, the shell's own convention. */
  CANCELLED: 130,
} as const

const SHORT: Record<string, string> = { y: 'yes', v: 'verbose', q: 'quiet', h: 'help' }
const VALUE_FLAGS = new Set([
  'merge-agent', 'only', 'profile', 'config', 'host', 'repo', 'vault', 'device',
])

/**
 * Every flag the CLI understands. Anything else is refused rather than ignored:
 * a silently dropped `--dry-runn` is a real push, and `--no-secretss` is a
 * credential in git. A typo must never be the difference between a preview and
 * an irreversible action.
 */
export const KNOWN_FLAGS = new Set([
  ...VALUE_FLAGS, ...Object.values(SHORT),
  'json', 'yes', 'verbose', 'quiet', 'help', 'version', 'dry-run', 'no-secrets', 'no-tui',
])

export function unknownFlags(flags: Record<string, string | boolean>): string[] {
  return Object.keys(flags).filter((f) => !KNOWN_FLAGS.has(f)).sort()
}

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

import { readFileSync } from 'node:fs'
import { helpFor, ROOT_HELP } from './help.js'
import { flagsNotUsedBy, parseOnly, parseAgent } from './flags.js'
import { emitJson, emitJsonError } from './output.js'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { silenceSqliteExperimentalWarning } from './util/sqlite.js'

/**
 * Read the version off the package manifest rather than duplicating it in a
 * constant that drifts. The bundle lives in dist/, and the sources in src/, so
 * the manifest is one level up from either.
 */
export function packageVersion(): string {
  try {
    const path = fileURLToPath(new URL('../package.json', import.meta.url))
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** What is wrong with these arguments, or undefined when nothing is. */
function checkArguments(args: ParsedArgs): string | undefined {
  const unknown = unknownFlags(args.flags)
  if (unknown.length > 0) {
    const names = unknown.map((f) => `"--${f}"`).join(', ')
    return `unknown flag${unknown.length > 1 ? 's' : ''} ${names} — run \`syncskills --help\``
  }

  // --help and --version answer whatever else was typed, so they skip the rest.
  if (args.flags.help === true || args.flags.version === true || args.command === 'help') {
    return undefined
  }

  const unused = flagsNotUsedBy(args.command, args.flags)
  if (unused.length > 0) {
    const names = unused.map((f) => `"--${f}"`).join(', ')
    const hint = unused.includes('merge-agent')
      ? ' — conflicts are merged interactively; run `syncskills` with no arguments'
      : ''
    return `${names} ${unused.length > 1 ? 'are flags' : 'is a flag'} ` +
      `\`${args.command}\` does not use${hint}`
  }

  try {
    parseOnly(args.flags.only)
    parseAgent(args.flags['merge-agent'])
  } catch (e) {
    return (e as Error).message
  }
  return undefined
}

export async function main(argv: string[]): Promise<number> {
  // node:sqlite prints an ExperimentalWarning the first time it is touched.
  // Silence that one class so ordinary runs stay clean; everything else still
  // reaches the user.
  silenceSqliteExperimentalWarning()

  const args = parseArgs(argv)

  // The whole command line is judged here, before the command runs and before
  // the shape of the terminal decides anything: a flag that does not exist, one
  // this command has no use for, and a value that is not a valid one all mean
  // the user asked for something that will not happen, and must say so rather
  // than printing help and exiting 0.
  const badArguments = checkArguments(args)
  if (badArguments !== undefined) {
    if (args.flags.json === true) {
      emitJsonError(args.command, badArguments,
        { json: true, quiet: false, verbose: false, warnings: [] })
    } else {
      process.stderr.write(`syncskills: ${badArguments}\n`)
    }
    return EXIT.ERROR
  }

  // These three return before dispatch, so they have to honour --json
  // themselves. A wrapper that asked for the envelope and got help text is
  // exactly the shape --json exists to rule out.
  const io = { json: true, quiet: false, verbose: false, warnings: [] }

  if (args.flags.version === true) {
    if (args.flags.json === true) emitJson('version', { version: packageVersion() }, io)
    else process.stdout.write(`syncskills ${packageVersion()}\n`)
    return EXIT.OK
  }

  if (args.flags.help === true || args.command === 'help') {
    const topic = args.command === 'help' ? args.positionals[0] : args.command
    const text = helpFor(topic ?? 'tui')
    if (args.flags.json === true) emitJson('help', { topic: topic ?? 'tui', help: text }, io)
    else process.stdout.write(text + '\n')
    return EXIT.OK
  }
  if (args.command === 'tui' && (args.flags['no-tui'] === true || !process.stdout.isTTY)) {
    if (args.flags.json === true) emitJson('help', { topic: 'tui', help: ROOT_HELP }, io)
    else process.stdout.write(ROOT_HELP + '\n')
    return EXIT.OK
  }

  const { dispatch } = await import('./dispatch.js')
  return dispatch(args, args.flags.json === true)
}

// process.argv[1] can be relative, so it must go through pathToFileURL rather
// than being pasted after "file://" — otherwise the first path segment is
// parsed as a hostname and the comparison silently never matches.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((e: Error) => {
      process.stderr.write(`syncskills: ${e.message}\n`)
      process.exitCode = EXIT.ERROR
    })
}
