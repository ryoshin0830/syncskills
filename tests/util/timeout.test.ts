import { describe, it, expect } from 'vitest'
import { run } from '../../src/util/exec.js'

describe('run with a timeout', () => {
  it('gives up on a child that never exits', async () => {
    const started = Date.now()
    const r = await run('sh', ['-c', 'sleep 30'], { timeoutMs: 300 })

    // The caller needs a result it can act on, not a promise that never
    // settles: a merge agent that stops responding would otherwise leave the
    // interactive spinner turning forever.
    expect(r.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
  })

  /**
   * 'close' fires when the child's stdio closes, not when the child exits — and
   * a child that left something of its own behind holding those pipes never
   * closes them. Killing the child then produced 'exit' and no 'close', so the
   * promise never settled and the caller waited for ever. `sh -c 'sleep 30'`
   * happens to exec-replace the shell on macOS and so never showed this; on
   * Linux it is what CI saw.
   */
  it('gives up even when the child left something holding its pipes', async () => {
    const started = Date.now()
    const r = await run('sh', ['-c', 'sleep 30 & wait'], { timeoutMs: 300 })

    expect(r.code).not.toBe(0)
    expect(r.stderr).toMatch(/without exiting/)
    expect(Date.now() - started).toBeLessThan(10_000)
  }, 15_000)

  it('leaves a child that finishes in time alone', async () => {
    const r = await run('sh', ['-c', 'echo done'], { timeoutMs: 10_000 })
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('done')
  })

  it('waits indefinitely when no timeout is asked for', async () => {
    const r = await run('sh', ['-c', 'sleep 0.2; echo late'])
    expect(r.code).toBe(0)
    expect(r.stdout.trim()).toBe('late')
  })
})
