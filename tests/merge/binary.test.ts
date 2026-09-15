import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, chmod, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeTrees } from '../../src/merge/index.js'
import { noAgent } from '../../src/merge/agent.js'
import type { MergeAgent } from '../../src/merge/agent.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ss-bin-')) })

const unionAgent: MergeAgent = {
  name: 'test-union',
  async merge(req) { return `${req.local}${req.remote}` },
}

/** Three PNGs whose differing bytes are all invalid UTF-8. */
const png = (tail: number[]): Buffer =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...tail])

async function tree(
  name: string, files: Record<string, string | Buffer>, exec: string[] = [],
): Promise<string> {
  const d = join(root, name)
  await mkdir(d, { recursive: true })
  for (const [p, body] of Object.entries(files)) await writeFile(join(d, p), body)
  for (const p of exec) await chmod(join(d, p), 0o755)
  return d
}

describe('mergeTrees with content that is not UTF-8 text', () => {
  it('reports a binary both sides changed as unresolved instead of taking one silently', async () => {
    const base = await tree('b', { 'logo.png': png([0x00, 0x01, 0x02]) })
    const local = await tree('l', { 'logo.png': png([0xff, 0xfe, 0xfd]) })
    const remote = await tree('r', { 'logo.png': png([0xc0, 0xc1, 0xc2]) })
    const out = join(root, 'out')

    const rep = await mergeTrees({
      baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent,
    })

    // Decoding both sides as utf8 collapses every invalid byte to U+FFFD, which
    // makes two different images compare equal. That must not read as a merge.
    expect(rep.files.find((f) => f.path === 'logo.png')?.how).toBe('unresolved')
    expect(rep.resolved).toBe(false)
  })

  it('takes the changed side when only one side moved a binary', async () => {
    const base = await tree('b', { 'logo.png': png([0x00, 0x01, 0x02]) })
    const local = await tree('l', { 'logo.png': png([0x00, 0x01, 0x02]) })
    const remote = await tree('r', { 'logo.png': png([0xc0, 0xc1, 0xc2]) })
    const out = join(root, 'out')

    const rep = await mergeTrees({
      baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent,
    })

    expect(rep.resolved).toBe(true)
    expect(rep.files.find((f) => f.path === 'logo.png')?.how).toBe('remote-only')
    expect(await readFile(join(out, 'logo.png'))).toEqual(png([0xc0, 0xc1, 0xc2]))
  })

  it('keeps a binary byte-for-byte when both sides made the same change', async () => {
    const same = png([0xc0, 0xc1, 0xc2])
    const base = await tree('b', { 'logo.png': png([0x00, 0x01, 0x02]) })
    const local = await tree('l', { 'logo.png': same })
    const remote = await tree('r', { 'logo.png': same })
    const out = join(root, 'out')

    const rep = await mergeTrees({
      baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent,
    })

    expect(rep.files.find((f) => f.path === 'logo.png')?.how).toBe('identical')
    expect(await readFile(join(out, 'logo.png'))).toEqual(same)
  })
})

describe('mergeTrees and the executable bit', () => {
  it('keeps the executable bit through a clean git merge', async () => {
    const base = await tree('b', { 'run.sh': '#!/bin/sh\nA\nB\nC\n' }, ['run.sh'])
    const local = await tree('l', { 'run.sh': '#!/bin/sh\nA-local\nB\nC\n' }, ['run.sh'])
    const remote = await tree('r', { 'run.sh': '#!/bin/sh\nA\nB\nC-remote\n' }, ['run.sh'])
    const out = join(root, 'out')

    const rep = await mergeTrees({
      baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: noAgent(),
    })

    expect(rep.files.find((f) => f.path === 'run.sh')?.how).toBe('git')
    // treeHash() hashes the executable bit, so losing it here would propagate a
    // non-executable script to every other machine.
    expect((await stat(join(out, 'run.sh'))).mode & 0o111).not.toBe(0)
  })

  it('keeps the executable bit through an agent merge', async () => {
    const base = await tree('b', { 'run.sh': 'base\n' }, ['run.sh'])
    const local = await tree('l', { 'run.sh': 'local\n' }, ['run.sh'])
    const remote = await tree('r', { 'run.sh': 'remote\n' }, ['run.sh'])
    const out = join(root, 'out')

    const rep = await mergeTrees({
      baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent,
    })

    expect(rep.files.find((f) => f.path === 'run.sh')?.how).toBe('agent')
    expect((await stat(join(out, 'run.sh'))).mode & 0o111).not.toBe(0)
  })

  it('leaves a file that was not executable alone', async () => {
    const base = await tree('b', { 'notes.md': 'a\nb\nc\n' })
    const local = await tree('l', { 'notes.md': 'a-local\nb\nc\n' })
    const remote = await tree('r', { 'notes.md': 'a\nb\nc-remote\n' })
    const out = join(root, 'out')

    await mergeTrees({
      baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: noAgent(),
    })

    expect((await stat(join(out, 'notes.md'))).mode & 0o111).toBe(0)
  })
})
