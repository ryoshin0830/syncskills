import { describe, it, expect, vi, afterEach } from 'vitest'
import { emitJson, emitJsonError } from '../src/output.js'
import type { Io } from '../src/output.js'

const io = (): Io => ({ json: true, quiet: false, verbose: false, warnings: [] })

function capture(fn: () => void): string {
  let out = ''
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk)
    return true
  })
  try { fn() } finally { spy.mockRestore() }
  return out
}

afterEach(() => { vi.restoreAllMocks() })

describe('emitJson', () => {
  it('defaults to ok: true', () => {
    const env = JSON.parse(capture(() => { emitJson('sync', { a: 1 }, io()) })) as { ok: boolean }
    expect(env.ok).toBe(true)
  })

  /**
   * The envelope is advertised as a stable contract for agents. `ok: true`
   * alongside a non-zero exit code made the two halves disagree.
   */
  it('reports ok: false when the command did not succeed', () => {
    const env = JSON.parse(capture(() => { emitJson('sync', {}, io(), false) })) as { ok: boolean }
    expect(env.ok).toBe(false)
  })

  it('carries warnings and a fixed schema version', () => {
    const withWarn = io()
    withWarn.warnings.push('careful')
    const env = JSON.parse(capture(() => { emitJson('status', null, withWarn) })) as
      { warnings: string[]; schemaVersion: number }
    expect(env.warnings).toEqual(['careful'])
    expect(env.schemaVersion).toBe(1)
  })

  it('always reports ok: false for an error envelope', () => {
    const env = JSON.parse(capture(() => { emitJsonError('sync', 'boom', io()) })) as
      { ok: boolean; error: string; data: unknown }
    expect(env.ok).toBe(false)
    expect(env.error).toBe('boom')
    expect(env.data).toBeNull()
  })
})
