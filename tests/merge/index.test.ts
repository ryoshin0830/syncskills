import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { mergeTrees } from '../../src/merge/index.js'
import type { MergeAgent } from '../../src/merge/agent.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ss-mt-')) })

async function tree(name: string, files: Record<string, string>) {
  const d = join(root, name)
  await mkdir(d, { recursive: true })
  for (const [p, body] of Object.entries(files)) {
    await mkdir(dirname(join(d, p)), { recursive: true })
    await writeFile(join(d, p), body)
  }
  return d
}

const unionAgent: MergeAgent = {
  name: 'test-union',
  async merge(req) { return `${req.local}${req.remote}` },
}
const failingAgent: MergeAgent = {
  name: 'test-fail',
  async merge() { throw new Error('agent unavailable') },
}

describe('mergeTrees', () => {
  it('takes a file that only the local side added', async () => {
    const base = await tree('b', { 'SKILL.md': 'x\n' })
    const local = await tree('l', { 'SKILL.md': 'x\n', 'extra.md': 'new\n' })
    const remote = await tree('r', { 'SKILL.md': 'x\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(rep.resolved).toBe(true)
    expect(await readFile(join(out, 'extra.md'), 'utf8')).toBe('new\n')
  })

  it('keeps a file that only the remote side added', async () => {
    const base = await tree('b', { 'SKILL.md': 'x\n' })
    const local = await tree('l', { 'SKILL.md': 'x\n' })
    const remote = await tree('r', { 'SKILL.md': 'x\n', 'r.md': 'remote\n' })
    const out = join(root, 'out')
    await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(await readFile(join(out, 'r.md'), 'utf8')).toBe('remote\n')
  })

  it('honours a deletion when the surviving side never touched the file', async () => {
    const base = await tree('b', { 'a.md': 'same\n', 'b.md': 'keep\n' })
    const local = await tree('l', { 'a.md': 'same\n', 'b.md': 'keep\n' })
    const remote = await tree('r', { 'b.md': 'keep\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(existsSync(join(out, 'a.md'))).toBe(false)
    expect(rep.files.find((f) => f.path === 'a.md')!.how).toBe('deleted')
  })

  it('keeps a file the other side deleted when this side edited it', async () => {
    const base = await tree('b', { 'a.md': 'same\n' })
    const local = await tree('l', { 'a.md': 'EDITED\n' })
    const remote = await tree('r', {})
    const out = join(root, 'out')
    await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(await readFile(join(out, 'a.md'), 'utf8')).toBe('EDITED\n')
  })

  it('resolves non-overlapping edits with git, never calling the agent', async () => {
    let called = false
    const spy: MergeAgent = { name: 's', async merge(r) { called = true; return r.local } }
    const base = await tree('b', { 'a.md': '1\n2\n3\n' })
    const local = await tree('l', { 'a.md': 'L\n2\n3\n' })
    const remote = await tree('r', { 'a.md': '1\n2\nR\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: spy })
    expect(called).toBe(false)
    expect(rep.files.find((f) => f.path === 'a.md')!.how).toBe('git')
    const merged = await readFile(join(out, 'a.md'), 'utf8')
    expect(merged).toContain('L')
    expect(merged).toContain('R')
  })

  it('escalates a genuine overlap to the agent', async () => {
    const base = await tree('b', { 'a.md': 'same\n' })
    const local = await tree('l', { 'a.md': 'LOCAL\n' })
    const remote = await tree('r', { 'a.md': 'REMOTE\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(rep.files.find((f) => f.path === 'a.md')!.how).toBe('agent')
    expect(await readFile(join(out, 'a.md'), 'utf8')).toBe('LOCAL\nREMOTE\n')
  })

  it('marks a file unresolved when the agent fails, and writes nothing for it', async () => {
    const base = await tree('b', { 'a.md': 'same\n' })
    const local = await tree('l', { 'a.md': 'LOCAL\n' })
    const remote = await tree('r', { 'a.md': 'REMOTE\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: failingAgent })
    expect(rep.resolved).toBe(false)
    expect(rep.files.find((f) => f.path === 'a.md')!.how).toBe('unresolved')
    expect(existsSync(join(out, 'a.md'))).toBe(false)
  })

  it('marks a file unresolved when the agent returns conflict markers', async () => {
    const bad: MergeAgent = {
      name: 'bad',
      async merge() { return '<<<<<<< a\nx\n=======\ny\n>>>>>>> b\n' },
    }
    const base = await tree('b', { 'a.md': 'same\n' })
    const local = await tree('l', { 'a.md': 'LOCAL\n' })
    const remote = await tree('r', { 'a.md': 'REMOTE\n' })
    const out = join(root, 'out')
    expect((await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: bad })).resolved)
      .toBe(false)
  })

  it('marks a SKILL.md unresolved when the agent destroys its frontmatter', async () => {
    const bad: MergeAgent = { name: 'bad', async merge() { return 'no frontmatter at all\n' } }
    const base = await tree('b', { 'SKILL.md': '---\nname: a\ndescription: d\n---\nsame\n' })
    const local = await tree('l', { 'SKILL.md': '---\nname: a\ndescription: d\n---\nLOCAL\n' })
    const remote = await tree('r', { 'SKILL.md': '---\nname: a\ndescription: d\n---\nREMOTE\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: bad })
    expect(rep.resolved).toBe(false)
    expect(rep.files[0]!.reason).toMatch(/frontmatter/)
  })

  it('handles a missing base by treating it as empty on both sides', async () => {
    const local = await tree('l', { 'a.md': 'LOCAL\n' })
    const remote = await tree('r', { 'a.md': 'REMOTE\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    expect(rep.resolved).toBe(true)
    expect(await readFile(join(out, 'a.md'), 'utf8')).toBe('LOCAL\nREMOTE\n')
  })

  it('merges nested files, not just the top level', async () => {
    const base = await tree('b', { 'scripts/go.sh': 'a\nb\nc\n' })
    const local = await tree('l', { 'scripts/go.sh': 'A\nb\nc\n' })
    const remote = await tree('r', { 'scripts/go.sh': 'a\nb\nC\n' })
    const out = join(root, 'out')
    await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: unionAgent })
    const merged = await readFile(join(out, 'scripts', 'go.sh'), 'utf8')
    expect(merged).toContain('A')
    expect(merged).toContain('C')
  })

  it('reports identical files without touching the agent', async () => {
    const base = await tree('b', { 'a.md': 'x\n' })
    const local = await tree('l', { 'a.md': 'same\n' })
    const remote = await tree('r', { 'a.md': 'same\n' })
    const out = join(root, 'out')
    const rep = await mergeTrees({ baseDir: base, localDir: local, remoteDir: remote, outDir: out, agent: failingAgent })
    expect(rep.resolved).toBe(true)
    expect(rep.files[0]!.how).toBe('identical')
  })
})
