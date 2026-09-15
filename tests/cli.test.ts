import { describe, it, expect } from 'vitest'
import { parseArgs, unknownFlags, packageVersion, EXIT } from '../src/cli.js'
import { parseOnly } from '../src/flags.js'

describe('parseArgs', () => {
  it('defaults to the tui command when given no arguments', () => {
    expect(parseArgs([]).command).toBe('tui')
  })

  it('reads a subcommand and its positionals', () => {
    const a = parseArgs(['diff', 'code-review'])
    expect(a.command).toBe('diff')
    expect(a.positionals).toEqual(['code-review'])
  })

  it('treats long flags without a value as boolean true', () => {
    expect(parseArgs(['sync', '--yes']).flags.yes).toBe(true)
  })

  it('reads --flag=value and --flag value alike', () => {
    expect(parseArgs(['sync', '--merge-agent=codex']).flags['merge-agent']).toBe('codex')
    expect(parseArgs(['sync', '--merge-agent', 'codex']).flags['merge-agent']).toBe('codex')
  })

  it('expands short aliases', () => {
    expect(parseArgs(['sync', '-y']).flags.yes).toBe(true)
    expect(parseArgs(['sync', '-v']).flags.verbose).toBe(true)
  })

  it('stops flag parsing after --', () => {
    expect(parseArgs(['sync', '--', '--yes']).positionals).toEqual(['--yes'])
  })

  it('fixes the exit code contract', () => {
    expect(EXIT).toEqual({ OK: 0, ERROR: 1, CONFLICT: 2, UNINITIALIZED: 3, CANCELLED: 130 })
  })
})

describe('flag validation', () => {
  it('accepts every flag the help pages advertise', () => {
    expect(unknownFlags(parseArgs(['sync', '--yes', '--dry-run', '--json']).flags)).toEqual([])
    expect(unknownFlags(parseArgs(['sync', '--only', 'skills', '--no-secrets']).flags)).toEqual([])
    expect(unknownFlags(parseArgs(['init', '--host', 'h', '--repo', 'o/r', '--vault', 'v',
                                   '--device', 'd']).flags)).toEqual([])
    expect(unknownFlags(parseArgs(['sync', '-y', '-v', '-q']).flags)).toEqual([])
    expect(unknownFlags(parseArgs(['status', '--profile', 'p', '--config', 'c',
                                   '--merge-agent', 'codex', '--no-tui', '--version']).flags))
      .toEqual([])
  })

  /**
   * A typo must not become a different, irreversible command. `--dry-runn` used
   * to parse as an unknown boolean, be ignored, and push for real.
   */
  it('refuses a near miss rather than ignoring it', () => {
    for (const typo of ['dry-runn', 'yess', 'no-secretss', 'jsonn', 'onlyy']) {
      expect(unknownFlags(parseArgs(['sync', `--${typo}`]).flags), typo).toEqual([typo])
    }
  })

  it('refuses an unknown short flag', () => {
    expect(unknownFlags(parseArgs(['sync', '-z']).flags)).toEqual(['z'])
  })

  it('lists every unknown flag, sorted', () => {
    expect(unknownFlags(parseArgs(['sync', '--zebra', '--apple']).flags))
      .toEqual(['apple', 'zebra'])
  })
})

describe('parseOnly', () => {
  it('maps singular and plural names alike', () => {
    expect(parseOnly('skills')).toEqual(['skill'])
    expect(parseOnly('skill')).toEqual(['skill'])
    expect(parseOnly('mcp,repos')).toEqual(['mcp', 'repo'])
  })

  it('de-duplicates', () => {
    expect(parseOnly('skills,skill')).toEqual(['skill'])
  })

  it('passes undefined through, meaning every kind', () => {
    expect(parseOnly(undefined)).toBeUndefined()
  })

  /**
   * Falling back to "no filter" turned `--only skil` into a full sync of
   * everything — the opposite of what was asked for.
   */
  it('refuses a name that is not a kind', () => {
    expect(() => parseOnly('skil')).toThrow(/unknown kind "skil"/)
    expect(() => parseOnly('skills,bogus')).toThrow(/bogus/)
  })

  it('refuses --only with no value', () => {
    expect(() => parseOnly(true)).toThrow(/needs a value/)
    expect(() => parseOnly('')).toThrow(/needs a value/)
  })
})

describe('packageVersion', () => {
  it('reports the version from the package manifest', () => {
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })
})
