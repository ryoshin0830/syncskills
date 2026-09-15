import { describe, it, expect, beforeEach } from 'vitest'
import { buildDeeplink, createWriter } from '../../src/ccswitch/write.js'
import { makeStubBin, type Stub } from '../helpers/stubBin.js'
import { makeFakeCcSwitch, type FakeHome } from '../helpers/fakeCcSwitch.js'

describe('buildDeeplink', () => {
  const cfg = { type: 'stdio', command: 'echo', args: ['hi'], env: {} }

  it('produces a ccswitch://v1/import URL for the mcp resource', () => {
    const url = buildDeeplink('x', cfg, ['claude'])
    expect(url.startsWith('ccswitch://v1/import?')).toBe(true)
    expect(url).toContain('resource=mcp')
  })

  it('joins apps with commas', () => {
    const params = new URL(buildDeeplink('x', cfg, ['claude', 'codex'])).searchParams
    expect(params.get('apps')).toBe('claude,codex')
  })

  it('base64-encodes an mcpServers document keyed by the server id', () => {
    const url = new URL(buildDeeplink('my-server', cfg, ['claude']))
    const b64 = url.searchParams.get('config')!
    const json = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(Object.keys(json.mcpServers)).toEqual(['my-server'])
    expect(json.mcpServers['my-server']).toEqual(cfg)
  })

  it('uses URL-safe base64 so + and / never appear in the config parameter', () => {
    const heavy = { type: 'stdio', command: '???>>>', args: ['ÿþý', '~~~???'] }
    const b64 = new URL(buildDeeplink('x', heavy, ['claude'])).searchParams.get('config')!
    expect(b64).not.toMatch(/[+/]/)
  })

  it('round-trips a config containing characters that need escaping', () => {
    const tricky = { command: 'a b&c=d?e#f', args: ['%20', '"quoted"'] }
    const b64 = new URL(buildDeeplink('t', tricky, ['claude'])).searchParams.get('config')!
    const json = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as {
      mcpServers: Record<string, unknown>
    }
    expect(json.mcpServers.t).toEqual(tricky)
  })

  it('rejects an empty app list, which cc-switch refuses', () => {
    expect(() => buildDeeplink('x', cfg, [])).toThrow(/at least one app/i)
  })
})

describe('CcWriter', () => {
  let stub: Stub
  let f: FakeHome
  beforeEach(async () => {
    stub = await makeStubBin('cc-switch')
    f = await makeFakeCcSwitch()
  })

  it('invokes deeplink for an MCP import', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.importMcp('o', { type: 'stdio', command: 'x' }, ['claude'])
    const calls = await stub.calls()
    expect(calls[0]).toContain('deeplink')
    expect(calls[0]).toContain('ccswitch://v1/import')
  })

  it('invokes mcp set-apps with a comma list', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.setMcpApps('o', ['claude', 'hermes'])
    expect((await stub.calls())[0]).toBe('mcp set-apps o --apps claude,hermes')
  })

  it('invokes skills set-apps with a comma list', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.setSkillApps('code-review', ['codex'])
    expect((await stub.calls())[0]).toBe('skills set-apps code-review --apps codex')
  })

  it('invokes skills import-from-apps for a new skill', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.importSkill('code-review', ['claude'])
    expect((await stub.calls())[0]).toBe('skills import-from-apps code-review --apps claude')
  })

  it('invokes skills sync', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.syncSkills()
    expect((await stub.calls())[0]).toBe('skills sync')
  })

  it('raises a descriptive error when the binary fails', async () => {
    const bad = await makeStubBin('cc-switch', 3)
    const w = createWriter({ bin: bad.bin, paths: f })
    await expect(w.syncSkills()).rejects.toThrow(/cc-switch skills sync failed \(exit 3\)/)
  })

  it('names the failing operation in the error, not just the exit code', async () => {
    const bad = await makeStubBin('cc-switch', 1)
    const w = createWriter({ bin: bad.bin, paths: f })
    await expect(w.setMcpApps('o', ['claude'])).rejects.toThrow(/mcp set-apps failed/)
  })
})

describe('importMcpWithSecrets', () => {
  let stub: Stub
  let f: FakeHome
  beforeEach(async () => {
    stub = await makeStubBin('cc-switch')
    f = await makeFakeCcSwitch()
  })

  it('never puts a credential on the command line', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    await w.importMcpWithSecrets(
      'o',
      { type: 'stdio', command: 'x', env: { API_KEY: 'sk-super-secret-value' } },
      { API_KEY: 'sk-super-secret-value' },
      ['claude'],
    ).catch(() => undefined)

    const calls = (await stub.calls()).join('\n')
    expect(calls).not.toContain('sk-super-secret-value')

    // The deeplink still carries the KEY NAME, which is part of the shape.
    const url = calls.split(' ').find((t) => t.startsWith('ccswitch://'))!
    const b64 = new URL(url).searchParams.get('config')!
    const doc = Buffer.from(b64, 'base64url').toString('utf8')
    expect(doc).not.toContain('sk-super-secret-value')
    expect(doc).toContain('API_KEY')
  })

  it('reports success without touching the database when there is nothing secret', async () => {
    const w = createWriter({ bin: stub.bin, paths: f })
    const outcome = await w.importMcpWithSecrets(
      'o', { type: 'stdio', command: 'x' }, {}, ['claude'],
    )
    expect(outcome).toBe('deleted')
  })
})
