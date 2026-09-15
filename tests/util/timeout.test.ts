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
