import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitStore, PushRejected } from '../../src/store/git.js'
import { makeBareRemote } from '../helpers/bareRemote.js'
import type { Config } from '../../src/config.js'

const base: Config = {
  schemaVersion: 1, host: 'github.com', owner: 'o', repo: 'r', branch: 'main',
  device: 'dev', vault: 'agent', item: 'syncskills', secrets: false, excludes: [],
}

describe('a push another device got in first', () => {
  let remote: string
  beforeEach(async () => { remote = await makeBareRemote() })

  const store = async () => {
    const s = createGitStore({
      cacheDir: await mkdtemp(join(tmpdir(), 'ss-cache-')), config: base, remoteOverride: remote,
    })
    await s.ensure()
    return s
  }

  it('is a PushRejected, not an anonymous git failure', async () => {
    // Two clones of the same commit. A pushes; B then pushes without fetching,
    // which is exactly what two machines syncing at the same time produce.
    const a = await store()
    const b = await store()

    await writeFile(join(a.dir, 'a.txt'), 'from a\n')
    expect(await a.commitAndPush('from a')).toBe(true)

    await writeFile(join(b.dir, 'b.txt'), 'from b\n')
    await expect(b.commitAndPush('from b')).rejects.toBeInstanceOf(PushRejected)
  })

  it('says what happened in words the user can act on', async () => {
    const a = await store()
    const b = await store()
    await writeFile(join(a.dir, 'a.txt'), 'from a\n')
    await a.commitAndPush('from a')
    await writeFile(join(b.dir, 'b.txt'), 'from b\n')

    const err = await b.commitAndPush('from b').catch((e: Error) => e)
    expect(err).toBeInstanceOf(PushRejected)
    expect((err as Error).message).toMatch(/another device/i)
    expect((err as Error).message).toMatch(/again/i)
  })

  it('leaves a genuine git failure as an ordinary error', async () => {
    const s = createGitStore({
      cacheDir: await mkdtemp(join(tmpdir(), 'ss-cache-')),
      config: base,
      remoteOverride: join(tmpdir(), 'ss-does-not-exist-at-all.git'),
    })
    await expect(s.ensure()).rejects.not.toBeInstanceOf(PushRejected)
  })
})
