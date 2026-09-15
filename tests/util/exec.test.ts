import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  /**
   * A Buffer added to a string decodes that chunk on its own, so a multi-byte
   * character straddling a 64KB pipe boundary became U+FFFD. This output is not
   * for display: mergeFile() and the merge agents return it as the merged text,
   * which is written into the skill and pushed to every other machine.
   */
  it('keeps multi-byte characters intact across chunk boundaries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ss-utf8-'))
    const file = join(dir, 'big.txt')
    const text = 'あ'.repeat(200_000) + '\n'
    await writeFile(file, text)

    const r = await run('cat', [file])

    expect(r.stdout.includes('\uFFFD')).toBe(false)
    expect(r.stdout).toBe(text)
  })

  it('keeps multi-byte characters intact on stderr too', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ss-utf8e-'))
    const file = join(dir, 'big.txt')
    // Three bytes, so it does not divide the 64KB pipe buffer evenly and is
    // guaranteed to straddle a boundary; a 4-byte character would not.
    const text = 'あ'.repeat(200_000) + '\n'
    await writeFile(file, text)

    const r = await run('sh', ['-c', `cat ${JSON.stringify(file)} >&2`])

    expect(r.stderr.includes('\uFFFD')).toBe(false)
    expect(r.stderr).toBe(text)
  })

  it('rejects when the binary does not exist', async () => {
    await expect(run('definitely-not-a-real-binary-xyz', [])).rejects.toThrow()
  })
})
