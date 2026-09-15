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

describe('credential repair and the empty matrix', () => {
  let stub: Stub
  let f: FakeHome
  const stopped = async () => false
  const running = async () => true

  beforeEach(async () => {
    stub = await makeStubBin('cc-switch')
    f = await makeFakeCcSwitch()
  })

  it('writes a missing credential into an existing server', async () => {
    const { addMcp } = await import('../helpers/fakeCcSwitch.js')
    addMcp(f, 'o', { type: 'stdio', command: 'x', env: { API_KEY: '' } }, ['claude'])

    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: stopped })
    expect(await w.repairMcpSecrets('o', { API_KEY: 'sk-restored' })).toBe('deleted')

    const { readMcp } = await import('../../src/ccswitch/read.js')
    expect((readMcp(f)[0]!.config.env as Record<string, string>).API_KEY).toBe('sk-restored')
  })

  it('never puts the restored credential on a command line', async () => {
    const { addMcp } = await import('../helpers/fakeCcSwitch.js')
    addMcp(f, 'o', { type: 'stdio', command: 'x', env: { API_KEY: '' } }, ['claude'])
    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: stopped })
    await w.repairMcpSecrets('o', { API_KEY: 'sk-restored' })
    expect((await stub.calls()).join('\n')).not.toContain('sk-restored')
  })

  it('refuses while cc-switch is live, and says why', async () => {
    const { addMcp } = await import('../helpers/fakeCcSwitch.js')
    addMcp(f, 'o', { type: 'stdio', command: 'x', env: { API_KEY: '' } }, ['claude'])
    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: running })
    expect(await w.repairMcpSecrets('o', { API_KEY: 'sk' })).toBe('pending')
    expect(w.lastPendingReason()).toMatch(/cc-switch is running/)
  })

  it('disables an item everywhere, which cc-switch refuses to express', async () => {
    const { addMcp } = await import('../helpers/fakeCcSwitch.js')
    addMcp(f, 'o', { type: 'stdio', command: 'x' }, ['claude', 'codex'])

    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: stopped })
    await w.setMcpApps('o', [])

    const { readMcp } = await import('../../src/ccswitch/read.js')
    expect(readMcp(f)[0]!.apps).toEqual([])
    // It must not have tried `set-apps --apps ''`, which the real binary rejects.
    expect((await stub.calls()).join('\n')).not.toContain('--apps ')
  })

  it('reports why an empty matrix could not be applied', async () => {
    const { addMcp } = await import('../helpers/fakeCcSwitch.js')
    addMcp(f, 'o', { type: 'stdio', command: 'x' }, ['claude'])
    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: running })
    await expect(w.setMcpApps('o', [])).rejects.toThrow(/cc-switch is running/)
  })

  /**
   * deleteSkillRow and directDelete both check the row exists first, so that
   * "the caller never records a delete that did not happen". Clearing a matrix
   * has exactly the same obligation: reporting success for a row that is not
   * there writes a base and a manifest entry describing a state the database
   * does not hold.
   */
  it('refuses to claim it disabled a server that has no row', async () => {
    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: stopped })
    await expect(w.setMcpApps('never-existed', [])).rejects.toThrow(/never-existed/)
  })

  it('refuses to claim it disabled a skill that has no row', async () => {
    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: stopped })
    await expect(w.setSkillApps('never-existed', [])).rejects.toThrow(/never-existed/)
  })
})

describe('importing something that is enabled nowhere', () => {
  let stub: Stub
  let f: FakeHome
  const stopped = async () => false
  const running = async () => true

  beforeEach(async () => {
    stub = await makeStubBin('cc-switch')
    f = await makeFakeCcSwitch()
  })

  /**
   * cc-switch refuses `--apps ''` everywhere, so an item disabled in every
   * harness cannot be imported directly. It used to throw — after the existing
   * row had already been deleted, which lost the server outright.
   */
  it('never asks cc-switch to accept an empty app list', async () => {
    const { addMcp } = await import('../helpers/fakeCcSwitch.js')
    // The stub binary does not write rows, so the row stands in for what the
    // deep link would have created.
    addMcp(f, 'o', { type: 'stdio', command: 'x' }, ['claude'])

    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: stopped })
    await w.importMcp('o', { type: 'stdio', command: 'x' }, [])

    const calls = (await stub.calls()).join('\n')
    expect(calls).not.toMatch(/--apps\s*$/m)
    const url = calls.split(/\s+/).find((t) => t.startsWith('ccswitch://'))!
    expect(new URL(url).searchParams.get('apps')).toBeTruthy()
  })

  it('leaves the imported server disabled everywhere', async () => {
    const { addMcp } = await import('../helpers/fakeCcSwitch.js')
    // The stub binary does not write rows, so the row stands in for what the
    // deep link would have created.
    addMcp(f, 'o', { type: 'stdio', command: 'x' }, ['claude', 'codex'])

    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: stopped })
    await w.importMcp('o', { type: 'stdio', command: 'x' }, [])

    const { readMcp } = await import('../../src/ccswitch/read.js')
    expect(readMcp(f)[0]!.apps).toEqual([])
  })

  it('imports a skill that is enabled nowhere', async () => {
    const { addSkill } = await import('../helpers/fakeCcSwitch.js')
    // Stands in for the row `skills import-from-apps` would have created.
    await addSkill(f, 'quiet', '---\nname: quiet\ndescription: d\n---\nQ\n', ['claude'])

    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: stopped })
    await w.importSkill('quiet', [])

    const calls = await stub.calls()
    expect(calls[0]).toMatch(/^skills import-from-apps quiet --apps \S+$/)
    expect(calls.join('\n')).not.toMatch(/--apps\s*$/m)
  })

  it('reports pending rather than throwing when the matrix cannot be cleared', async () => {
    const { addMcp } = await import('../helpers/fakeCcSwitch.js')
    addMcp(f, 'o', { type: 'stdio', command: 'x' }, ['claude'])

    // cc-switch is live, so the database is off limits; the import already
    // happened, so the caller must not record a base for it.
    const w = createWriter({ bin: stub.bin, paths: f, isCcSwitchRunning: running })
    const outcome = await w.importMcpWithSecrets('o', { type: 'stdio', command: 'x' }, {}, [])
    expect(outcome).toBe('pending')
    expect(w.lastPendingReason()).toMatch(/cc-switch is running/)
  })
})
