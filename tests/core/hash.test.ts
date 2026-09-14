import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treeHash, canonicalize, canonicalJsonHash } from '../../src/core/hash.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ss-hash-')) })

describe('canonicalize', () => {
  it('sorts object keys so key order cannot change the hash', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJsonHash({ b: 1, a: 2 })).toBe(canonicalJsonHash({ a: 2, b: 1 }))
  })

  it('preserves array order, which is significant', () => {
    expect(canonicalJsonHash([1, 2])).not.toBe(canonicalJsonHash([2, 1]))
  })

  it('drops undefined members', () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}')
  })
})

describe('treeHash', () => {
  it('is stable across calls', async () => {
    await writeFile(join(dir, 'SKILL.md'), 'hello')
    expect(await treeHash(dir)).toBe(await treeHash(dir))
  })

  it('changes when a file body changes', async () => {
    await writeFile(join(dir, 'SKILL.md'), 'a')
    const before = await treeHash(dir)
    await writeFile(join(dir, 'SKILL.md'), 'b')
    expect(await treeHash(dir)).not.toBe(before)
  })

  it('changes when a file is added', async () => {
    await writeFile(join(dir, 'SKILL.md'), 'a')
    const before = await treeHash(dir)
    await writeFile(join(dir, 'extra.md'), 'x')
    expect(await treeHash(dir)).not.toBe(before)
  })

  it('changes when a file is renamed', async () => {
    await writeFile(join(dir, 'a.md'), 'same')
    const before = await treeHash(dir)
    await writeFile(join(dir, 'b.md'), 'same')
    expect(await treeHash(dir)).not.toBe(before)
  })

  it('changes when the executable bit changes', async () => {
    const f = join(dir, 'run.sh')
    await writeFile(f, '#!/bin/sh\n')
    await chmod(f, 0o644)
    const before = await treeHash(dir)
    await chmod(f, 0o755)
    expect(await treeHash(dir)).not.toBe(before)
  })

  it('ignores .DS_Store and .git', async () => {
    await writeFile(join(dir, 'SKILL.md'), 'a')
    const before = await treeHash(dir)
    await writeFile(join(dir, '.DS_Store'), 'junk')
    await mkdir(join(dir, '.git'))
    await writeFile(join(dir, '.git', 'HEAD'), 'ref')
    expect(await treeHash(dir)).toBe(before)
  })

  it('hashes nested files by their relative path', async () => {
    await mkdir(join(dir, 'scripts'))
    await writeFile(join(dir, 'scripts', 'q.sh'), 'echo')
    const a = await treeHash(dir)
    expect(a.startsWith('sha256:')).toBe(true)
  })

  it('follows a symlinked file and hashes its target content', async () => {
    const target = join(dir, 'real.md')
    await writeFile(target, 'content')
    await mkdir(join(dir, 'sub'))
    await symlink(target, join(dir, 'sub', 'link.md'))
    expect((await treeHash(dir)).startsWith('sha256:')).toBe(true)
  })

  it('throws when the directory is missing', async () => {
    await expect(treeHash(join(dir, 'nope'))).rejects.toThrow()
  })
})
