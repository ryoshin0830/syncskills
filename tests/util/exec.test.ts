import { describe, it, expect } from 'vitest'
import { run } from '../../src/util/exec.js'

describe('run', () => {
  it('captures stdout and the exit code', async () => {
    const r = await run('sh', ['-c', 'echo hi; exit 3'])
    expect(r.code).toBe(3)
    expect(r.stdout.trim()).toBe('hi')
  })

  it('feeds input to the child', async () => {
    const r = await run('cat', [], { input: 'from stdin' })
    expect(r.stdout).toBe('from stdin')
  })

  /**
   * A merge agent that dies before reading its prompt — a failed login, a rate
   * limit, a flag it does not know — used to take the whole CLI down with an
   * unhandled EPIPE instead of being reported as a failed merge.
   */
  it('survives a child that exits without reading its stdin', async () => {
    const big = 'x'.repeat(4 * 1024 * 1024)
    const r = await run('sh', ['-c', 'exit 42'], { input: big })
    expect(r.code).toBe(42)
  })

  it('still reports a child that closes stdin early but succeeds', async () => {
    const big = 'y'.repeat(4 * 1024 * 1024)
    const r = await run('sh', ['-c', 'echo done'], { input: big })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('done')
  })

  it('rejects when the binary does not exist', async () => {
    await expect(run('definitely-not-a-real-binary-xyz', [])).rejects.toThrow()
  })
})
