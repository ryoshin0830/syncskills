import { describe, it, expect } from 'vitest'
import { mkdtemp, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectGhHosts, ensureRepo, parseRepoSlug } from '../../src/commands/init.js'
import { makeStubBin } from '../helpers/stubBin.js'
import type { Config } from '../../src/config.js'

async function fakeGh(payload: string, code = 0): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ss-gh-'))
  const bin = join(dir, 'gh')
  await writeFile(bin, `#!/bin/sh\ncat <<'J'\n${payload}\nJ\nexit ${code}\n`)
  await chmod(bin, 0o755)
  return bin
}

describe('detectGhHosts', () => {
  it('parses gh auth status --json hosts', async () => {
    const bin = await fakeGh(JSON.stringify({
      hosts: {
        'github.com': [{ login: 'alice', active: true }, { login: 'bob', active: false }],
        'ghe.example.com': [{ login: 'carol', active: true }],
      },
    }))
    expect(await detectGhHosts(bin)).toEqual([
      { host: 'github.com', login: 'alice', active: true },
      { host: 'github.com', login: 'bob', active: false },
      { host: 'ghe.example.com', login: 'carol', active: true },
    ])
  })

  it('returns an empty list when gh is not authenticated', async () => {
    const stub = await makeStubBin('gh', 1)
    expect(await detectGhHosts(stub.bin)).toEqual([])
  })

  it('returns an empty list when gh is not installed at all', async () => {
    expect(await detectGhHosts('/nonexistent/gh')).toEqual([])
  })

  it('returns an empty list rather than throwing on unparsable output', async () => {
    const bin = await fakeGh('not json at all')
    expect(await detectGhHosts(bin)).toEqual([])
  })
})

const config: Config = {
  schemaVersion: 1, host: 'github.com', owner: 'o', repo: 'r', branch: 'main',
  device: 'd', vault: 'agent', item: 'syncskills', secrets: true, excludes: [],
}

describe('ensureRepo', () => {
  it('reports an existing repository without creating one', async () => {
    const stub = await makeStubBin('gh', 0)
    expect(await ensureRepo(config, stub.bin)).toBe('exists')
    expect(await stub.calls()).toHaveLength(1)
  })

  it('creates the repository when it does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ss-gh2-'))
    const bin = join(dir, 'gh')
    const log = join(dir, 'log')
    // `repo view` fails, `repo create` succeeds.
    await writeFile(bin, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
case "$1$2" in
  repoview) exit 1 ;;
  *) exit 0 ;;
esac
`)
    await chmod(bin, 0o755)
    await writeFile(log, '')
    expect(await ensureRepo(config, bin)).toBe('created')
  })

  it('raises a message naming the host when creation fails', async () => {
    const stub = await makeStubBin('gh', 1)
    await expect(ensureRepo(config, stub.bin)).rejects.toThrow(/could not create o\/r on github\.com/)
  })
})

describe('parseRepoSlug', () => {
  it('splits owner from name', () => {
    expect(parseRepoSlug('me/syncskills')).toEqual({ owner: 'me', repo: 'syncskills' })
  })

  it('tolerates surrounding whitespace', () => {
    expect(parseRepoSlug('  me/syncskills  ')).toEqual({ owner: 'me', repo: 'syncskills' })
  })

  /**
   * A bare name used to be read as the owner, silently pairing it with a
   * default repository name and pointing the device at the wrong place.
   */
  it('refuses anything that is not owner/name', () => {
    for (const bad of ['syncskills', 'a/b/c', '/name', 'owner/', '', '   ']) {
      expect(() => parseRepoSlug(bad), bad).toThrow(/owner\/name/)
    }
  })
})
