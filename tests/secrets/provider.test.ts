import { describe, it, expect } from 'vitest'
import { memoryProvider, nullProvider, emptyBlob } from '../../src/secrets/provider.js'

describe('memoryProvider', () => {
  it('round-trips a blob', async () => {
    const p = memoryProvider()
    const b = emptyBlob()
    b.mcp.oracle = { env: { API_KEY: 'sk-1' } }
    await p.write(b)
    expect((await p.read()).mcp.oracle!.env.API_KEY).toBe('sk-1')
  })

  it('hands back a copy, so a caller cannot mutate the stored blob', async () => {
    const p = memoryProvider()
    const b = emptyBlob()
    b.mcp.x = { env: { K: 'v' } }
    await p.write(b)
    const got = await p.read()
    got.mcp.x!.env.K = 'tampered'
    expect((await p.read()).mcp.x!.env.K).toBe('v')
  })

  it('reports healthy', async () => {
    expect((await memoryProvider().check()).ok).toBe(true)
  })
})

describe('nullProvider', () => {
  it('always reads an empty blob', async () => {
    expect((await nullProvider().read()).mcp).toEqual({})
  })

  it('accepts writes silently so --no-secrets never fails a sync', async () => {
    const b = emptyBlob()
    b.mcp.x = { env: { K: 'v' } }
    await expect(nullProvider().write(b)).resolves.toBeUndefined()
  })

  it('reports healthy and says why', async () => {
    const c = await nullProvider().check()
    expect(c.ok).toBe(true)
    expect(c.detail).toMatch(/no-secrets/)
  })
})
