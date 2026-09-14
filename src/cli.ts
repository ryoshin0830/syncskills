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
