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

import { helpFor, ROOT_HELP } from './help.js'
import { pathToFileURL } from 'node:url'
import { silenceSqliteExperimentalWarning } from './util/sqlite.js'

export async function main(argv: string[]): Promise<number> {
  // node:sqlite prints an ExperimentalWarning the first time it is touched.
  // Silence that one class so ordinary runs stay clean; everything else still
  // reaches the user.
  silenceSqliteExperimentalWarning()

  const args = parseArgs(argv)

  if (args.flags.help === true || args.command === 'help') {
    const topic = args.command === 'help' ? args.positionals[0] : args.command
    process.stdout.write(helpFor(topic ?? 'tui') + '\n')
    return EXIT.OK
  }
  if (args.command === 'tui' && (args.flags['no-tui'] === true || !process.stdout.isTTY)) {
    process.stdout.write(ROOT_HELP + '\n')
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
