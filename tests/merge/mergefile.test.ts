import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeFile } from '../../src/merge/mergefile.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ss-mf-')) })

async function files(base: string, local: string, remote: string) {
  const b = join(dir, 'base'), l = join(dir, 'local'), r = join(dir, 'remote')
  await writeFile(b, base); await writeFile(l, local); await writeFile(r, remote)
  return { b, l, r }
}

describe('mergeFile', () => {
  it('merges non-overlapping edits cleanly, keeping both', async () => {
    const { b, l, r } = await files(
      'line1\nline2\nline3\n', 'CHANGED1\nline2\nline3\n', 'line1\nline2\nCHANGED3\n',
    )
    const out = await mergeFile(b, l, r)
    expect(out.clean).toBe(true)
    expect(out.text).toContain('CHANGED1')
    expect(out.text).toContain('CHANGED3')
  })

  it('reports a conflict when the same line changed on both sides', async () => {
    const { b, l, r } = await files('same\n', 'local\n', 'remote\n')
    const out = await mergeFile(b, l, r)
    expect(out.clean).toBe(false)
    expect(out.text).toContain('<<<<<<<')
  })

  it('keeps an addition made on only one side', async () => {
    const { b, l, r } = await files('a\n', 'a\nb\n', 'a\n')
    const out = await mergeFile(b, l, r)
    expect(out.clean).toBe(true)
    expect(out.text).toBe('a\nb\n')
  })

  it('merges two additions at opposite ends of the file', async () => {
    const { b, l, r } = await files('m\n', 'top\nm\n', 'm\nbottom\n')
    const out = await mergeFile(b, l, r)
    expect(out.clean).toBe(true)
    expect(out.text).toContain('top')
    expect(out.text).toContain('bottom')
  })
})

/**
 * Regression: run() used to decode each pipe chunk on its own, so a clean merge
 * of a large Japanese skill came back with U+FFFD where a character straddled a
 * 64KB boundary — and mergeTrees writes that straight into the skill.
 */
it('returns a large Japanese merge undamaged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ss-mf-utf8-'))
  const lines = Array.from({ length: 20_000 }, (_, i) => `行${i}：日本語のスキル本文です。`)
  const base = lines.join('\n') + '\n'
  const b = join(dir, 'base')
  const l = join(dir, 'local')
  const r = join(dir, 'remote')
  await writeFile(b, base)
  await writeFile(l, base + 'ローカルの追記\n')
  await writeFile(r, 'リモートの追記\n' + base)

  const out = await mergeFile(b, l, r)

  expect(out.clean).toBe(true)
  expect(out.text.includes('�')).toBe(false)
  expect(out.text).toContain('ローカルの追記')
  expect(out.text).toContain('リモートの追記')
})
