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

describe('repositories and unmanaged skills', () => {
  it('propagates a skill repository from A to B', async () => {
    A.addRepoRow('anthropics', 'skills', 'main', true)
    await A.sync()
    expect(await A.readRemoteFile('repos/anthropics/skills.json')).toContain('"branch"')

    await B.sync()
    expect(B.listRepoRows()).toEqual([
      { owner: 'anthropics', name: 'skills', branch: 'main', enabled: true },
    ])
  })

  it('converges on repositories — a second sync plans nothing', async () => {
    A.addRepoRow('a', 'b', 'main', true)
    await A.sync()
    const second = await A.sync()
    expect(second.plan.actions).toHaveLength(0)
    expect(second.pushed).toBe(false)
  })

  it('carries a non-default branch and the disabled flag', async () => {
    A.addRepoRow('o', 'n', 'dev', false)
    await A.sync()
    await B.sync()
    expect(B.listRepoRows()).toEqual([
      { owner: 'o', name: 'n', branch: 'dev', enabled: false },
    ])
  })

  it('reports a skill directory cc-switch does not manage instead of ignoring it', async () => {
    await A.addUnmanagedSkillDir('stray', '---\nname: stray\ndescription: d\n---\nbody\n')
    await A.writeSkill('managed', skill('managed', 'v1'))
    await A.sync()

    // The unmanaged directory is not pushed...
    expect(await A.readRemoteFile('skills/stray/SKILL.md')).toBeNull()
    expect(await A.readRemoteFile('skills/managed/SKILL.md')).toContain('v1')

    // ...but it is visible rather than silently dropped.
    const { unmanagedSkills } = await import('../../src/ccswitch/read.js')
    expect(unmanagedSkills(A.paths)).toEqual(['stray'])
  })
})

describe('app matrix convergence (regression: a merged matrix must reach both sides)', () => {
  it('does not revert the other device’s enablement after a local content edit', async () => {
    await A.writeSkill('s', skill('s', 'v1'), ['claude'])
    await A.sync(); await B.sync()

    // B enables the skill for another harness and publishes that.
    await B.setSkillApps('s', ['claude', 'gemini'])
    await B.sync()

    // A edits the text — a push — while the remote matrix has moved on.
    await A.writeSkill('s', skill('s', 'v2'))
    await A.sync()
    expect(A.readSkillApps('s')).toEqual(['claude', 'gemini'])

    // The next sync must not undo B's enablement.
    const third = await A.sync()
    expect(third.plan.actions.map((x) => x.type)).not.toContain('set-apps')
    expect(A.readSkillApps('s')).toEqual(['claude', 'gemini'])

    await B.sync()
    expect(B.readSkillApps('s')).toEqual(['claude', 'gemini'])
  })

  it('does not lose a local enablement after pulling someone else’s content edit', async () => {
    await A.writeSkill('s', skill('s', 'v1'), ['claude'])
    await A.sync(); await B.sync()

    // A enables locally but does not sync; B edits the text and publishes.
    await A.setSkillApps('s', ['claude', 'hermes'])
    await B.writeSkill('s', skill('s', 'from-B'))
    await B.sync()

    await A.sync()
    expect(await A.readSkill('s')).toContain('from-B')
    expect(A.readSkillApps('s')).toEqual(['claude', 'hermes'])

    const again = await A.sync()
    expect(again.plan.actions).toHaveLength(0)
    await B.sync()
    expect(B.readSkillApps('s')).toEqual(['claude', 'hermes'])
  })
})

describe('MCP servers end to end', () => {
  it('lands the server on the receiving device, not just in the store', async () => {
    A.addMcpServer('oracle', { type: 'stdio', command: 'oracle-mcp', args: [] }, ['claude', 'codex'])
    await A.sync()
    await B.sync()

    const rows = B.listMcpRows()
    expect(rows.map((r) => r.id)).toEqual(['oracle'])
    expect(rows[0]!.config).toMatchObject({ type: 'stdio', command: 'oracle-mcp' })
    expect(rows[0]!.apps).toEqual(['claude', 'codex'])
  })

  it('converges for a tagged server, which cc-switch cannot transfer tags for', async () => {
    A.addMcpServerWithTags('tagged', { type: 'stdio', command: 'x' }, ['claude'], ['a', 'b'])
    await A.sync()
    await B.sync()

    // B receives the server; the tags stay on A, and neither side loops.
    expect(B.listMcpRows().map((r) => r.id)).toEqual(['tagged'])
    expect((await B.sync()).plan.actions).toHaveLength(0)
    expect((await A.sync()).plan.actions).toHaveLength(0)
  })

  it('converges for a plain server too', async () => {
    A.addMcpServer('plain', { type: 'stdio', command: 'x' }, ['claude'])
    await A.sync(); await B.sync()
    expect((await B.sync()).plan.actions).toHaveLength(0)
  })
})

describe('MCP updates (regression: the deep link cannot update an existing server)', () => {
  it('pulls a changed config instead of pushing the stale one back', async () => {
    A.addMcpServer('srv', { type: 'stdio', command: 'v1' }, ['claude', 'codex'])
    await A.sync(); await B.sync()

    B.setMcpConfig('srv', { type: 'stdio', command: 'v2' })
    await B.sync()

    await A.sync()
    expect(A.listMcpRows()[0]!.config).toMatchObject({ command: 'v2' })

    const again = await A.sync()
    expect(again.plan.actions).toHaveLength(0)
  })

  it('pulls a narrowed app matrix, which an additive import cannot express', async () => {
    A.addMcpServer('srv', { type: 'stdio', command: 'x' }, ['claude', 'codex'])
    await A.sync(); await B.sync()

    B.setMcpApps('srv', ['claude'])
    await B.sync()

    await A.sync()
    expect(A.listMcpRows()[0]!.apps).toEqual(['claude'])
    expect((await A.sync()).plan.actions).toHaveLength(0)
  })

  it('handles a config change and a matrix change arriving together', async () => {
    A.addMcpServer('srv', { type: 'stdio', command: 'v1' }, ['claude', 'codex'])
    await A.sync(); await B.sync()

    B.setMcpConfig('srv', { type: 'stdio', command: 'v2' })
    B.setMcpApps('srv', ['claude'])
    await B.sync()

    await A.sync()
    expect(A.listMcpRows()[0]!.config).toMatchObject({ command: 'v2' })
    expect(A.listMcpRows()[0]!.apps).toEqual(['claude'])
    expect((await A.sync()).plan.actions).toHaveLength(0)
    expect((await B.sync()).plan.actions).toHaveLength(0)
  })
})

describe('unsafe ids are refused symmetrically', () => {
  it('does not push a skill whose name would be unsafe as a path elsewhere', async () => {
    await A.writeSkill('.hidden', skill('hidden', 'v1'))
    await A.writeSkill('normal', skill('normal', 'v1'))
    const out = await A.sync()

    expect(out.plan.actions.map((x) => x.id)).toEqual(['normal'])
    expect(await A.readRemoteFile('manifest.json')).not.toContain('.hidden')

    await B.sync()
    expect(await B.readSkill('normal')).toContain('v1')
    expect(await B.readSkill('.hidden')).toBeNull()
  })
})

describe('base trees exist wherever a merge might need one', () => {
  it('records one for a skill that arrived identical on both devices', async () => {
    const body = skill('twin', 'identical')
    await A.writeSkill('twin', body)
    await B.writeSkill('twin', body)
    await A.sync()
    await B.sync()

    const { existingBaseTree } = await import('../../src/basetree.js')
    expect(existingBaseTree(B.configDir, 'skill', 'twin')).toBeDefined()
    expect(existingBaseTree(A.configDir, 'skill', 'twin')).toBeDefined()
  })

  it('merges three-way rather than treating a later divergence as two creations', async () => {
    const body = skill('twin', 'line1\nline2\nline3')
    await A.writeSkill('twin', body)
    await B.writeSkill('twin', body)
    await A.sync(); await B.sync(); await A.sync()

    await A.writeSkill('twin', skill('twin', 'A-LINE\nline2\nline3'))
    await B.writeSkill('twin', skill('twin', 'line1\nline2\nB-LINE'))
    await B.sync()

    const out = await A.sync()
    const conflict = out.unresolved.find((c) => c.id === 'twin')!
    // With a base recorded, this is a concurrent edit — not two independent
    // creations, which is what it would look like with no base at all.
    expect(conflict.resolution.conflictKind).toBe('both-edited')
  })
})
