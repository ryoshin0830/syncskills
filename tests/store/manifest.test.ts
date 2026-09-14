import { describe, it, expect } from 'vitest'
import {
  emptyManifest, parseManifest, serializeManifest, manifestSides, upsertEntry, removeEntry,
} from '../../src/store/manifest.js'

describe('manifest', () => {
  it('serializes deterministically so an unchanged sync produces no git diff', () => {
    const a = emptyManifest()
    upsertEntry(a, 'skill', 'b', { contentHash: 'sha256:1', apps: ['claude'] }, 'dev')
    upsertEntry(a, 'skill', 'a', { contentHash: 'sha256:2', apps: ['codex'] }, 'dev')
    const first = serializeManifest(a)
    expect(serializeManifest(parseManifest(first))).toBe(first)
  })

  it('writes entry keys in sorted order', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'z', { contentHash: 'sha256:1', apps: [] }, 'dev')
    upsertEntry(m, 'mcp', 'a', { contentHash: 'sha256:2', apps: [] }, 'dev')
    const keys = Object.keys((JSON.parse(serializeManifest(m)) as { entries: object }).entries)
    expect(keys).toEqual([...keys].sort())
  })

  it('starts a new entry at version 1', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    expect(m.entries['skill:a']!.version).toBe(1)
  })

  it('increments the version when the content changes', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:2', apps: [] }, 'dev')
    expect(m.entries['skill:a']!.version).toBe(2)
  })

  it('increments the version when only the app matrix changes', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: ['claude'] }, 'dev')
    expect(m.entries['skill:a']!.version).toBe(2)
  })

  it('leaves the version and timestamp alone when nothing changed', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    const before = { ...m.entries['skill:a']! }
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'other-device')
    expect(m.entries['skill:a']).toEqual(before)
  })

  it('records the device that made the change', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'home-mac')
    expect(m.entries['skill:a']!.updatedBy).toBe('home-mac')
  })

  it('never writes payload into the manifest', () => {
    const m = emptyManifest()
    upsertEntry(m, 'mcp', 'o', {
      contentHash: 'sha256:1', apps: [], payload: { env: { K: 'sk-secret' } },
    }, 'dev')
    expect(serializeManifest(m)).not.toContain('sk-secret')
  })

  it('projects sides for one kind only', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: ['claude'] }, 'dev')
    upsertEntry(m, 'mcp', 'b', { contentHash: 'sha256:2', apps: [] }, 'dev')
    const sides = manifestSides(m, 'skill')
    expect([...sides.keys()]).toEqual(['a'])
    expect(sides.get('a')).toEqual({ contentHash: 'sha256:1', apps: ['claude'] })
  })

  it('keeps a skill and an mcp with the same id apart', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'x', { contentHash: 'sha256:s', apps: [] }, 'dev')
    upsertEntry(m, 'mcp', 'x', { contentHash: 'sha256:m', apps: [] }, 'dev')
    expect(manifestSides(m, 'skill').get('x')!.contentHash).toBe('sha256:s')
    expect(manifestSides(m, 'mcp').get('x')!.contentHash).toBe('sha256:m')
  })

  it('carries no generated-at stamp, so a no-op sync produces no commit', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    const first = serializeManifest(m)
    const second = serializeManifest(parseManifest(first))
    expect(second).toBe(first)
    expect(first).not.toMatch(/generatedAt/)
  })

  it('removes an entry', () => {
    const m = emptyManifest()
    upsertEntry(m, 'skill', 'a', { contentHash: 'sha256:1', apps: [] }, 'dev')
    removeEntry(m, 'skill', 'a')
    expect(m.entries['skill:a']).toBeUndefined()
  })

  it('treats an unparsable manifest as a hard error, never as empty', () => {
    expect(() => parseManifest('{ broken')).toThrow(/manifest\.json is not valid JSON/)
  })

  it('rejects an unknown schema version', () => {
    expect(() => parseManifest(JSON.stringify({ schemaVersion: 2, entries: {} })))
      .toThrow(/schema version/i)
  })

  it('rejects a manifest with no entries object', () => {
    expect(() => parseManifest(JSON.stringify({ schemaVersion: 1 })))
      .toThrow(/no entries object/)
  })
})
