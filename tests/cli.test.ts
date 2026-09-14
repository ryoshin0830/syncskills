import { describe, it, expect } from 'vitest'
import { parseArgs, EXIT } from '../src/cli.js'

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
    expect(EXIT).toEqual({ OK: 0, ERROR: 1, CONFLICT: 2, UNINITIALIZED: 3 })
  })
})
