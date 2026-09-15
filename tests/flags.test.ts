import { describe, it, expect } from 'vitest'
import { parseArgs } from '../src/cli.js'
import { flagsNotUsedBy, parseAgent } from '../src/flags.js'

const flags = (argv: string[]) => parseArgs(argv).flags

describe('flags a command does not use', () => {
  it('refuses --merge-agent on sync, which never merges', () => {
    // sync's help says conflicts are NOT merged here. Accepting the flag and
    // ignoring it is the same silent-typo problem --dry-runn had.
    expect(flagsNotUsedBy('sync', flags(['sync', '--merge-agent', 'codex']))).toEqual(['merge-agent'])
  })

  it('refuses the init-only flags on sync', () => {
    expect(flagsNotUsedBy('sync', flags(['sync', '--repo', 'o/r', '--vault', 'v'])).sort())
      .toEqual(['repo', 'vault'])
  })

  it('accepts --merge-agent on the interactive command that does merge', () => {
    expect(flagsNotUsedBy('tui', flags(['--merge-agent', 'codex']))).toEqual([])
  })

  it('accepts every flag each command advertises', () => {
    expect(flagsNotUsedBy('sync', flags(['sync', '--yes', '--dry-run', '--only', 'skills',
                                         '--no-secrets', '--json']))).toEqual([])
    expect(flagsNotUsedBy('push', flags(['push', '--dry-run', '--only', 'mcp']))).toEqual([])
    expect(flagsNotUsedBy('pull', flags(['pull', '--yes', '--json']))).toEqual([])
    expect(flagsNotUsedBy('status', flags(['status', '--only', 'repos', '--json']))).toEqual([])
    expect(flagsNotUsedBy('init', flags(['init', '--host', 'h', '--repo', 'o/r', '--vault', 'v',
                                         '--device', 'd', '--no-secrets', '--json']))).toEqual([])
  })

  it('lets the global flags through everywhere', () => {
    for (const command of ['sync', 'status', 'diff', 'doctor', 'secrets', 'conflicts']) {
      expect(flagsNotUsedBy(command, flags([command, '--json', '--quiet', '--verbose',
                                            '--profile', 'p', '--config', '/tmp/x']))).toEqual([])
    }
  })
})

describe('parseAgent', () => {
  it('refuses an agent it does not know instead of quietly using another', () => {
    // --only was fixed to throw for exactly this reason; silently turning a
    // typo into "auto" is the same trap.
    expect(() => parseAgent('bogus')).toThrow(/unknown agent/)
  })

  it('reads the agents it does know', () => {
    expect(parseAgent('claude')).toBe('claude')
    expect(parseAgent('codex')).toBe('codex')
    expect(parseAgent('none')).toBe('none')
    expect(parseAgent('auto')).toBe('auto')
    expect(parseAgent(undefined)).toBe('auto')
  })

  it('refuses --merge-agent with no value', () => {
    expect(() => parseAgent(true)).toThrow(/merge-agent/)
  })
})

describe('main validates arguments before the terminal decides anything', () => {
  it('refuses a bad --merge-agent even where the interactive interface cannot run', async () => {
    const { main } = await import('../src/cli.js')
    const written: string[] = []
    const out = process.stdout.write.bind(process.stdout)
    const err = process.stderr.write.bind(process.stderr)
    process.stdout.write = (() => true) as typeof process.stdout.write
    process.stderr.write = ((c: string | Uint8Array) => { written.push(String(c)); return true }) as
      typeof process.stderr.write
    try {
      // Without a TTY this used to print the help page and exit 0, so a script
      // never learned that the agent it named does not exist.
      expect(await main(['--no-tui', '--merge-agent', 'claud'])).toBe(1)
      expect(written.join('')).toMatch(/unknown agent/)
    } finally {
      process.stdout.write = out
      process.stderr.write = err
    }
  })
})
