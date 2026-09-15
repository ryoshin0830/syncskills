import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadState, saveState, setBase, stateKey } from '../src/state.js'

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ss-state-')) })

describe('state', () => {
  it('returns an empty state when the file does not exist', async () => {
    const s = await loadState(dir)
    expect(s.schemaVersion).toBe(1)
    expect(s.items).toEqual({})
  })

  it('round-trips through disk', async () => {
    const s = await loadState(dir)
    setBase(s, 'skill', 'code-review', { contentHash: 'sha256:a', apps: ['claude'] })
    await saveState(dir, s)
    const again = await loadState(dir)
    expect(again.items[stateKey('skill', 'code-review')])
      .toEqual({ contentHash: 'sha256:a', apps: ['claude'] })
  })

  it('namespaces ids by kind so a skill and an mcp may share a name', async () => {
    const s = await loadState(dir)
    setBase(s, 'skill', 'x', { contentHash: 'sha256:s', apps: [] })
    setBase(s, 'mcp', 'x', { contentHash: 'sha256:m', apps: [] })
    expect(s.items['skill:x']!.contentHash).toBe('sha256:s')
    expect(s.items['mcp:x']!.contentHash).toBe('sha256:m')
  })

  it('removes an entry when the side is undefined', async () => {
    const s = await loadState(dir)
    setBase(s, 'skill', 'x', { contentHash: 'sha256:a', apps: [] })
    setBase(s, 'skill', 'x', undefined)
    expect(s.items['skill:x']).toBeUndefined()
  })

  it('never persists payload into the base', async () => {
    const s = await loadState(dir)
    setBase(s, 'mcp', 'o', {
      contentHash: 'sha256:a', apps: ['claude'],
      payload: { config: { env: { K: 'sk-secret' } } },
    })
    await saveState(dir, s)
    const raw = await readFile(join(dir, 'state.json'), 'utf8')
    expect(raw).not.toContain('sk-secret')
    expect(raw).not.toContain('payload')
  })

  it('writes atomically, leaving no partial file behind on rewrite', async () => {
    const s = await loadState(dir)
    setBase(s, 'skill', 'a', { contentHash: 'sha256:1', apps: [] })
    await saveState(dir, s)
    setBase(s, 'skill', 'a', { contentHash: 'sha256:2', apps: [] })
    await saveState(dir, s)
    const parsed = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as {
      items: Record<string, { contentHash: string }>
    }
    expect(parsed.items['skill:a']!.contentHash).toBe('sha256:2')
  })

  it('treats an unreadable state file as empty rather than crashing', async () => {
    await writeFile(join(dir, 'state.json'), '{ this is not json')
    expect((await loadState(dir)).items).toEqual({})
  })

  it('treats a future schema version as empty rather than misreading it', async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 9, items: { a: 1 } }))
    expect((await loadState(dir)).items).toEqual({})
  })

  it('stamps updatedAt on save', async () => {
    const s = await loadState(dir)
    const before = s.updatedAt
    await saveState(dir, s)
    expect(s.updatedAt).not.toBe(before)
  })
})
