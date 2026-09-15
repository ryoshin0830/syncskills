import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../../src/util/exec.js'
import { createGitStore, remoteUrl } from '../../src/store/git.js'
import { emptyManifest, upsertEntry } from '../../src/store/manifest.js'
import { makeBareRemote } from '../helpers/bareRemote.js'
import type { Config } from '../../src/config.js'

const base: Config = {
  schemaVersion: 1, host: 'github.com', owner: 'o', repo: 'r', branch: 'main',
  device: 'dev', vault: 'agent', item: 'oneset', secrets: true, excludes: [],
}

describe('remoteUrl', () => {
  it('builds an https URL for github.com', () => {
    expect(remoteUrl(base)).toBe('https://github.com/o/r.git')
  })
  it('builds an https URL for a GHES host', () => {
    expect(remoteUrl({ ...base, host: 'git.pepabo.com' })).toBe('https://git.pepabo.com/o/r.git')
  })
  it('uses an explicit remote when one is configured', () => {
    expect(remoteUrl({ ...base, remote: 'git@example.com:me/store.git' }))
      .toBe('git@example.com:me/store.git')
    expect(remoteUrl({ ...base, remote: '/srv/git/store.git' })).toBe('/srv/git/store.git')
  })
  it('ignores an empty explicit remote', () => {
    expect(remoteUrl({ ...base, remote: '' })).toBe('https://github.com/o/r.git')
  })
})

describe('GitStore', () => {
  let remote: string
  let cache: string

  beforeEach(async () => {
    remote = await makeBareRemote()
    cache = await mkdtemp(join(tmpdir(), 'ss-cache-'))
  })

  const store = (c: string) => createGitStore({ cacheDir: c, config: base, remoteOverride: remote })

  it('clones on first use', async () => {
    const s = store(cache)
    await s.ensure()
    expect((await run('git', ['-C', s.dir, 'rev-parse', 'HEAD'])).code).toBe(0)
  })

  it('returns an empty manifest when the remote has none', async () => {
    const s = store(cache)
    await s.ensure()
    expect((await s.readManifest()).entries).toEqual({})
  })

  it('commits and pushes, and a second clone sees the result', async () => {
    const s = store(cache)
    await s.ensure()
    await s.writeItemJson('mcp', 'oracle', { type: 'stdio', command: 'oracle-mcp' })
    expect(await s.commitAndPush('test: add oracle')).toBe(true)

    const s2 = store(await mkdtemp(join(tmpdir(), 'ss-cache2-')))
    await s2.ensure()
    expect(await s2.readItemJson('mcp', 'oracle')).toEqual({ type: 'stdio', command: 'oracle-mcp' })
  })

  it('round-trips a manifest through the remote', async () => {
    const s = store(cache)
    await s.ensure()
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'code-review', { contentHash: 'sha256:a', apps: ['claude'] }, 'dev-a')
    await s.writeManifest(m)
    await s.commitAndPush('test: manifest')

    const s2 = store(await mkdtemp(join(tmpdir(), 'ss-cache3-')))
    await s2.ensure()
    const back = await s2.readManifest()
    expect(back.entries['skill:code-review']!.contentHash).toBe('sha256:a')
    expect(back.entries['skill:code-review']!.updatedBy).toBe('dev-a')
  })

  it('round-trips a skill directory through the remote', async () => {
    const s = store(cache)
    await s.ensure()
    const d = s.itemDir('skill', 'code-review')
    await mkdir(join(d, 'scripts'), { recursive: true })
    await writeFile(join(d, 'SKILL.md'), '---\nname: code-review\ndescription: d\n---\nbody\n')
    await writeFile(join(d, 'scripts', 'go.sh'), 'echo hi\n')
    await s.commitAndPush('test: add skill')

    const s2 = store(await mkdtemp(join(tmpdir(), 'ss-cache4-')))
    await s2.ensure()
    expect(await readFile(join(s2.itemDir('skill', 'code-review'), 'SKILL.md'), 'utf8'))
      .toContain('name: code-review')
    expect(await readFile(join(s2.itemDir('skill', 'code-review'), 'scripts', 'go.sh'), 'utf8'))
      .toBe('echo hi\n')
  })

  it('reports no changes when nothing was written', async () => {
    const s = store(cache)
    await s.ensure()
    expect(await s.hasChanges()).toBe(false)
    expect(await s.commitAndPush('noop')).toBe(false)
  })

  it('removes an item and the removal propagates', async () => {
    const s = store(cache)
    await s.ensure()
    await s.writeItemJson('mcp', 'gone', { a: 1 })
    await s.commitAndPush('add')
    await s.removeItem('mcp', 'gone')
    await s.commitAndPush('remove')

    const s2 = store(await mkdtemp(join(tmpdir(), 'ss-cache5-')))
    await s2.ensure()
    expect(await s2.readItemJson('mcp', 'gone')).toBeNull()
  })

  it('removes a skill directory as well as a json item', async () => {
    const s = store(cache)
    await s.ensure()
    await mkdir(s.itemDir('skill', 'doomed'), { recursive: true })
    await writeFile(join(s.itemDir('skill', 'doomed'), 'SKILL.md'), 'x')
    await s.commitAndPush('add')
    await s.removeItem('skill', 'doomed')
    await s.commitAndPush('remove')

    const s2 = store(await mkdtemp(join(tmpdir(), 'ss-cache6-')))
    await s2.ensure()
    await expect(readFile(join(s2.itemDir('skill', 'doomed'), 'SKILL.md'), 'utf8')).rejects.toThrow()
  })

  it('discards local cache drift on ensure', async () => {
    const s = store(cache)
    await s.ensure()
    await writeFile(join(s.dir, 'stray.txt'), 'junk')
    await s.ensure()
    expect(await s.hasChanges()).toBe(false)
  })

  it('picks up a change another device pushed', async () => {
    const a = store(cache)
    await a.ensure()
    const b = store(await mkdtemp(join(tmpdir(), 'ss-cache7-')))
    await b.ensure()

    await a.writeItemJson('mcp', 'from-a', { v: 1 })
    await a.commitAndPush('a writes')

    expect(await b.readItemJson('mcp', 'from-a')).toBeNull()
    await b.ensure()
    expect(await b.readItemJson('mcp', 'from-a')).toEqual({ v: 1 })
  })

  it('reports an unreachable remote with an actionable message', async () => {
    const s = createGitStore({
      cacheDir: await mkdtemp(join(tmpdir(), 'ss-cache8-')),
      config: base,
      remoteOverride: '/nonexistent/path/to.git',
    })
    await expect(s.ensure()).rejects.toThrow(/could not clone/)
  })
})

/**
 * The cache is scratch, and a run that died between writing item files and
 * committing leaves it dirty. `checkout -B` refuses to overwrite local
 * modifications, so ensure() threw before reaching the `reset --hard` that
 * would have cleaned up — wedging every command that calls gather().
 */
describe('a cache left dirty by a run that died', () => {
  it('is cleaned up instead of wedging every later command', async () => {
    const remote = await makeBareRemote()
    const cacheDir = await mkdtemp(join(tmpdir(), 'ss-cache-'))
    const store = createGitStore({ cacheDir, config: base, remoteOverride: remote })
    await store.ensure()

    // Someone else publishes, so origin/main moves on.
    const other = await mkdtemp(join(tmpdir(), 'ss-other-'))
    await run('git', ['clone', remote, other])
    await run('git', ['-C', other, 'config', 'user.email', 't@example.com'])
    await run('git', ['-C', other, 'config', 'user.name', 'test'])
    await writeFile(join(other, 'README.md'), '# moved on\n')
    await run('git', ['-C', other, 'commit', '-am', 'move on'])
    await run('git', ['-C', other, 'push', 'origin', 'main'])

    // This machine crashed mid-apply: a tracked file is modified, uncommitted.
    await writeFile(join(cacheDir, 'repo', 'README.md'), '# half-written\n')

    await expect(store.ensure()).resolves.toBeUndefined()
    expect(await readFile(join(cacheDir, 'repo', 'README.md'), 'utf8')).toBe('# moved on\n')
  })
})
