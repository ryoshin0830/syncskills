import { describe, it, expect, beforeEach } from 'vitest'
import { makeBareRemote, makeDevice, type Device } from '../helpers/device.js'

const skill = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: a test skill\n---\n${body}\n`

let remote: string
let A: Device
let B: Device

beforeEach(async () => {
  remote = await makeBareRemote()
  A = await makeDevice('work-pc', remote)
  B = await makeDevice('home-mac', remote)
})

describe('two devices', () => {
  it('propagates a new skill from A to B', async () => {
    await A.writeSkill('code-review', skill('code-review', 'v1'))
    await A.sync()
    await B.sync()
    expect(await B.readSkill('code-review')).toContain('v1')
  })

  it('propagates an edit made on A after both are in sync', async () => {
    await A.writeSkill('s', skill('s', 'v1'))
    await A.sync(); await B.sync()

    await A.writeSkill('s', skill('s', 'v2'))
    await A.sync(); await B.sync()
    expect(await B.readSkill('s')).toContain('v2')
  })

  it('does not overwrite a newer remote when the local is unchanged', async () => {
    await A.writeSkill('s', skill('s', 'v1'))
    await A.sync(); await B.sync()

    await B.writeSkill('s', skill('s', 'from-B'))
    await B.sync()

    const out = await A.sync()
    expect(out.plan.actions.map((a) => a.type)).toContain('pull-content')
    expect(await A.readSkill('s')).toContain('from-B')
  })

  it('detects a genuine conflict when both edit the same skill', async () => {
    await A.writeSkill('s', skill('s', 'base'))
    await A.sync(); await B.sync()

    await A.writeSkill('s', skill('s', 'A-change'))
    await B.writeSkill('s', skill('s', 'B-change'))
    await B.sync()

    const out = await A.sync()
    expect(out.unresolved.map((c) => c.id)).toContain('s')
    // Nothing was overwritten while the conflict stands.
    expect(await A.readSkill('s')).toContain('A-change')
  })

  it('reports a delete on one side against an edit on the other as a conflict', async () => {
    await A.writeSkill('s', skill('s', 'v1'))
    await A.sync(); await B.sync()

    await A.deleteSkill('s')
    await B.writeSkill('s', skill('s', 'edited'))
    await B.sync()

    expect((await A.sync()).unresolved.map((c) => c.id)).toContain('s')
  })

  it('propagates a deletion when the other side did not touch it', async () => {
    await A.writeSkill('s', skill('s', 'v1'))
    await A.sync(); await B.sync()

    await A.deleteSkill('s')
    await A.sync()
    await B.sync()
    expect(await B.readSkill('s')).toBeNull()
  })

  it('gives a third device everything on its first sync', async () => {
    await A.writeSkill('one', skill('one', '1'))
    await A.writeSkill('two', skill('two', '2'))
    await A.sync()

    const C = await makeDevice('laptop', remote)
    await C.sync()
    expect(await C.readSkill('one')).toContain('1')
    expect(await C.readSkill('two')).toContain('2')
  })

  it('is idempotent — a second sync with no changes does nothing', async () => {
    await A.writeSkill('s', skill('s', 'v1'))
    await A.sync()

    const second = await A.sync()
    expect(second.plan.actions).toHaveLength(0)
    expect(second.pushed).toBe(false)
  })

  it('converges — syncing both devices twice leaves them identical', async () => {
    await A.writeSkill('a', skill('a', 'from-A'))
    await B.writeSkill('b', skill('b', 'from-B'))
    await A.sync(); await B.sync(); await A.sync(); await B.sync()

    expect(await A.readSkill('a')).toBe(await B.readSkill('a'))
    expect(await A.readSkill('b')).toBe(await B.readSkill('b'))
    expect(await A.readSkill('b')).toContain('from-B')
    expect(await B.readSkill('a')).toContain('from-A')
  })

  it('syncs an MCP server definition without leaking its env values', async () => {
    A.addMcpServer(
      'oracle',
      { type: 'stdio', command: 'oracle-mcp', env: { API_KEY: 'sk-secret-value-here' } },
      ['claude'],
    )
    await A.sync()

    const staged = await A.readRemoteFile('mcp/oracle.json')
    expect(staged).not.toBeNull()
    expect(staged).not.toContain('sk-secret-value-here')
    expect(staged).toContain('"secret": true')
    expect(staged).toContain('API_KEY')
  })

  it('never writes a credential into the manifest either', async () => {
    A.addMcpServer('o', { type: 'stdio', command: 'x', env: { TOKEN: 'ghp_secretsecret' } }, ['claude'])
    await A.sync()
    expect(await A.readRemoteFile('manifest.json')).not.toContain('ghp_secretsecret')
  })

  it('leaves the base intact when an apply fails midway', async () => {
    await A.writeSkill('s', skill('s', 'v1'))
    await A.sync()
    const before = await A.readState()

    await A.breakCcSwitch()
    await A.writeSkill('s', skill('s', 'v2'))
    await A.sync().catch(() => undefined)

    const after = await A.readState()
    expect(after.items['skill:s']!.contentHash).toBe(before.items['skill:s']!.contentHash)
  })

  it('recovers on the next run after a failed apply', async () => {
    await A.writeSkill('s', skill('s', 'v1'))
    await A.sync()

    await A.breakCcSwitch()
    await B.writeSkill('s2', skill('s2', 'from-B'))
    await B.sync()
    await A.sync().catch(() => undefined)

    await A.fixCcSwitch()
    await A.sync()
    expect(await A.readSkill('s2')).toContain('from-B')
  })

  it('push only sends; it never pulls', async () => {
    await A.writeSkill('a', skill('a', 'from-A'))
    await B.writeSkill('b', skill('b', 'from-B'))
    await B.sync()

    const out = await A.push()
    expect(out.result.applied.every((x) => x.type !== 'pull-content')).toBe(true)
    expect(await A.readSkill('b')).toBeNull()
  })

  it('pull only takes; it never sends', async () => {
    await A.writeSkill('a', skill('a', 'from-A'))
    await B.writeSkill('b', skill('b', 'from-B'))
    await B.sync()

    await A.pull()
    expect(await A.readSkill('b')).toContain('from-B')
    expect(await B.readRemoteFile('skills/a/SKILL.md')).toBeNull()
  })

  it('dry-run changes nothing anywhere', async () => {
    await A.writeSkill('s', skill('s', 'v1'))
    const out = await A.sync({ dryRun: true })
    expect(out.plan.actions.length).toBeGreaterThan(0)
    expect(out.pushed).toBe(false)
    expect(await A.readRemoteFile('skills/s/SKILL.md')).toBeNull()
    expect(Object.keys((await A.readState()).items)).toHaveLength(0)
  })

  it('carries the app matrix across devices', async () => {
    await A.writeSkill('s', skill('s', 'v1'), ['claude', 'hermes'])
    await A.sync()
    await B.sync()
    const remoteManifest = await B.readRemoteFile('manifest.json')
    expect(remoteManifest).toContain('hermes')
  })

  it('a five-way round trip between three devices converges', async () => {
    const C = await makeDevice('laptop', remote)
    await A.writeSkill('shared', skill('shared', 'one'))
    await A.sync(); await B.sync(); await C.sync()

    await B.writeSkill('shared', skill('shared', 'two'))
    await B.sync(); await A.sync(); await C.sync()

    expect(await A.readSkill('shared')).toContain('two')
    expect(await C.readSkill('shared')).toContain('two')
    expect(await A.readSkill('shared')).toBe(await C.readSkill('shared'))
  })
})
