import { describe, it, expect, beforeEach } from 'vitest'
import { makeBareRemote, makeDevice, type Device } from '../helpers/device.js'

/**
 * An MCP server changed on both machines used to be a dead end: `sync` reported
 * the conflict and pointed at the interactive interface, which then dropped
 * every non-skill conflict without a prompt. The only ways out were editing one
 * side by hand or adding the server to `excludes`.
 */
describe('an MCP server changed on both machines', () => {
  let a: Device
  let b: Device

  beforeEach(async () => {
    const remote = await makeBareRemote()
    a = await makeDevice('a', remote)
    b = await makeDevice('b', remote)
    a.addMcpServer('srv', { command: 'npx', args: ['-y', 'srv'] }, ['claude'])
    await a.sync()
    await b.sync()

    a.setMcpConfig('srv', { command: 'npx', args: ['-y', 'srv', '--from-a'] })
    b.setMcpConfig('srv', { command: 'npx', args: ['-y', 'srv', '--from-b'] })
    await a.sync()
  })

  it('is reported as a conflict, not silently decided', async () => {
    const out = await b.sync()
    expect(out.unresolved.map((c) => `${c.kind}/${c.id}`)).toEqual(['mcp/srv'])
  })

  it('can be settled by keeping this machine', async () => {
    await b.syncTakingSide('local')
    const row = b.listMcpRows().find((r) => r.id === 'srv')!
    expect(row.config).toEqual({ command: 'npx', args: ['-y', 'srv', '--from-b'] })
    expect(JSON.stringify(await b.readRemoteFile('mcp/srv.json'))).toContain('--from-b')
  })

  it('can be settled by taking the other machine', async () => {
    await b.syncTakingSide('remote')
    const row = b.listMcpRows().find((r) => r.id === 'srv')!
    expect(row.config).toEqual({ command: 'npx', args: ['-y', 'srv', '--from-a'] })
  })

  it('leaves nothing unresolved once a side is taken', async () => {
    const out = await b.syncTakingSide('remote')
    expect(out.unresolved).toEqual([])
  })

  it('converges — the next sync on either machine plans nothing', async () => {
    await b.syncTakingSide('remote')
    expect((await b.sync()).plan.actions).toEqual([])
    expect((await a.sync()).plan.actions).toEqual([])
    expect((await b.sync()).unresolved).toEqual([])
  })
})
