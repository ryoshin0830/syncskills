import { describe, it, expect } from 'vitest'
import { helpFor, ROOT_HELP } from '../src/help.js'

const COMMANDS = [
  'init', 'sync', 'status', 'push', 'pull', 'diff',
  'conflicts', 'secrets', 'doctor', 'config', 'completion',
]

describe('help', () => {
  it('lists every command at the root', () => {
    for (const c of COMMANDS) expect(ROOT_HELP).toContain(c)
  })

  it('documents the exit codes at the root', () => {
    expect(ROOT_HELP).toMatch(/EXIT CODES/)
    for (const line of ['0  success', '1  error', '2  unresolved', '3  not initialized']) {
      expect(ROOT_HELP).toContain(line)
    }
  })

  it('gives every command a help page with usage, flags and an example', () => {
    for (const c of COMMANDS) {
      const h = helpFor(c)
      expect(h.length, `${c} help is too short`).toBeGreaterThan(120)
      expect(h, `${c} help lacks USAGE`).toMatch(/USAGE/)
      expect(h, `${c} help lacks EXAMPLES`).toMatch(/EXAMPLES/)
      expect(h, `${c} help does not name itself`).toContain(`syncskills ${c}`)
    }
  })

  it('documents --json everywhere, because agents depend on it', () => {
    for (const c of COMMANDS) expect(helpFor(c), `${c} lacks --json`).toContain('--json')
  })

  it('every example in a page invokes syncskills', () => {
    for (const c of COMMANDS) {
      const examples = helpFor(c).split('EXAMPLES')[1] ?? ''
      const lines = examples.split('\n').map((l) => l.trim()).filter((l) => l.length > 0)
      expect(lines.length, `${c} has no examples`).toBeGreaterThan(0)
      expect(lines.some((l) => l.includes('syncskills')), `${c} examples omit the binary`).toBe(true)
    }
  })

  /**
   * `--merge-agent` only reaches the interactive interface. Advertising it on
   * `sync` told people it would merge, when it always reported exit 2 instead.
   */
  it('does not offer --merge-agent on the non-interactive commands', () => {
    for (const c of ['sync', 'push', 'pull']) {
      expect(helpFor(c), `${c} still advertises --merge-agent`).not.toMatch(/--merge-agent/)
    }
  })

  it('says where merging actually happens', () => {
    expect(ROOT_HELP).toMatch(/MERGING/)
    expect(ROOT_HELP).toMatch(/interactive/)
    expect(helpFor('sync')).toMatch(/NOT merged here/)
    expect(helpFor('sync')).toMatch(/no arguments/)
  })

  it('documents --version, which npx users reach for first', () => {
    expect(ROOT_HELP).toMatch(/--version/)
  })

  it('falls back to the root help for an unknown command', () => {
    expect(helpFor('nope')).toBe(ROOT_HELP)
  })
})
